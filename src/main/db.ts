import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import type { TranscriptionResult } from '../shared/types.ts'

let db: Database.Database

export function initDB(): void {
  db = new Database(path.join(app.getPath('userData'), 'nova-voice.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      language TEXT DEFAULT 'ko',
      duration REAL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      model_used TEXT DEFAULT 'whisper-large-v3-turbo-mlx'
    )
  `)

  const columns = db.pragma('table_info(transcriptions)') as Array<{ name: string }>
  if (columns.some(({ name }) => name === 'ai_mode' || name === 'ai_result')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE transcriptions_stt_only (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          language TEXT DEFAULT 'ko',
          duration REAL DEFAULT 0,
          timestamp INTEGER NOT NULL,
          model_used TEXT DEFAULT 'whisper-large-v3-turbo-mlx'
        );
        INSERT INTO transcriptions_stt_only (id, text, language, duration, timestamp, model_used)
        SELECT id, text, language, duration, timestamp, model_used FROM transcriptions;
        DROP TABLE transcriptions;
        ALTER TABLE transcriptions_stt_only RENAME TO transcriptions;
      `)
    })()
    console.log('[DB] Removed legacy AI columns; preserved transcription history')
  }
  const currentColumns = new Set(
    (db.pragma('table_info(transcriptions)') as Array<{ name: string }>).map(({ name }) => name),
  )
  if (!currentColumns.has('input_mode')) {
    db.exec("ALTER TABLE transcriptions ADD COLUMN input_mode TEXT DEFAULT 'normal'")
  }
  if (!currentColumns.has('source_text')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN source_text TEXT')
  }
  if (!currentColumns.has('meta_prompt_outcome')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_outcome TEXT')
  }
  if (!currentColumns.has('meta_prompt_provider')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_provider TEXT')
  }
  if (!currentColumns.has('processing_duration')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN processing_duration REAL')
  }
  if (!currentColumns.has('meta_prompt_duration')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN meta_prompt_duration REAL')
  }
  // Context of the dictation. Without it a stored row is just text, and "the
  // user said this *in this app*" — the relationship pattern learning needs —
  // cannot be recovered afterwards.
  if (!currentColumns.has('target_app')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN target_app TEXT')
  }
  if (!currentColumns.has('target_bundle_id')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN target_bundle_id TEXT')
  }
  if (!currentColumns.has('cli_target')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN cli_target INTEGER')
  }
  if (!currentColumns.has('is_slash_command')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN is_slash_command INTEGER')
  }
  if (!currentColumns.has('injected')) {
    db.exec('ALTER TABLE transcriptions ADD COLUMN injected INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp ON transcriptions(timestamp DESC)')

  // Learning is counted separately from history so that a phrase keeps its
  // weight even as old transcriptions age out of the visible list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_observations (
      phrase TEXT NOT NULL,
      command TEXT,
      bundle_id TEXT,
      hits INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (phrase, command, bundle_id)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_pattern_bundle ON pattern_observations(bundle_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pattern_last_seen ON pattern_observations(last_seen DESC)')
}

export interface PatternObservation {
  /** Raw spoken text, before any rewriting. */
  spokenText: string
  /** Normalised form used for counting; supplied by the learning module. */
  phrase: string
  /** Slash command this dictation resolved to, when it resolved to one. */
  command?: string
  bundleId?: string
}

export function recordPatternObservation(observation: PatternObservation): void {
  db.prepare(`
    INSERT INTO pattern_observations (phrase, command, bundle_id, hits, last_seen)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(phrase, command, bundle_id)
      DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen
  `).run(
    observation.phrase,
    observation.command ?? '',
    observation.bundleId ?? '',
    Date.now(),
  )
}

export interface PatternStats {
  commandPairs: Array<{ phrase: string; command: string; hits: number }>
  appCommands: Array<{ bundleId: string; command: string; hits: number }>
  appPhrases: Array<{ bundleId: string; phrase: string; hits: number }>
}

export function getPatternStats(): PatternStats {
  return {
    commandPairs: db.prepare(`
      SELECT phrase, command, SUM(hits) AS hits
      FROM pattern_observations
      WHERE command <> ''
      GROUP BY phrase, command
      ORDER BY hits DESC
      LIMIT 400
    `).all() as PatternStats['commandPairs'],
    appCommands: db.prepare(`
      SELECT bundle_id AS bundleId, command, SUM(hits) AS hits
      FROM pattern_observations
      WHERE command <> '' AND bundle_id <> ''
      GROUP BY bundle_id, command
      ORDER BY hits DESC
      LIMIT 200
    `).all() as PatternStats['appCommands'],
    appPhrases: db.prepare(`
      SELECT bundle_id AS bundleId, phrase, SUM(hits) AS hits
      FROM pattern_observations
      WHERE bundle_id <> ''
      GROUP BY bundle_id, phrase
      ORDER BY hits DESC, last_seen DESC
      LIMIT 200
    `).all() as PatternStats['appPhrases'],
  }
}

export function saveTranscription(result: TranscriptionResult): void {
  db.prepare(`
    INSERT INTO transcriptions (
      id, text, language, duration, timestamp, model_used,
      input_mode, source_text, meta_prompt_outcome, meta_prompt_provider,
      processing_duration, meta_prompt_duration,
      target_app, target_bundle_id, cli_target, is_slash_command, injected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.id,
    result.text,
    result.language,
    result.duration,
    result.timestamp,
    result.modelUsed,
    result.inputMode ?? 'normal',
    result.sourceText ?? null,
    result.metaPromptOutcome ?? null,
    result.metaPromptProvider ?? null,
    result.processingDuration ?? null,
    result.metaPromptDuration ?? null,
    result.targetApp ?? null,
    result.targetBundleId ?? null,
    result.cliTarget === undefined ? null : Number(result.cliTarget),
    result.isSlashCommand === undefined ? null : Number(result.isSlashCommand),
    result.injected === undefined ? null : Number(result.injected),
  )
}

export function getHistory(limit = 50, offset = 0): TranscriptionResult[] {
  return db.prepare(`
    SELECT id, text, language, duration, timestamp, model_used AS modelUsed,
      input_mode AS inputMode, source_text AS sourceText,
      meta_prompt_outcome AS metaPromptOutcome, meta_prompt_provider AS metaPromptProvider,
      processing_duration AS processingDuration, meta_prompt_duration AS metaPromptDuration,
      target_app AS targetApp, target_bundle_id AS targetBundleId,
      cli_target AS cliTarget, is_slash_command AS isSlashCommand, injected AS injected
    FROM transcriptions
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as TranscriptionResult[]
}

export function searchHistory(query: string): TranscriptionResult[] {
  return db.prepare(`
    SELECT id, text, language, duration, timestamp, model_used AS modelUsed,
      input_mode AS inputMode, source_text AS sourceText,
      meta_prompt_outcome AS metaPromptOutcome, meta_prompt_provider AS metaPromptProvider,
      processing_duration AS processingDuration, meta_prompt_duration AS metaPromptDuration,
      target_app AS targetApp, target_bundle_id AS targetBundleId,
      cli_target AS cliTarget, is_slash_command AS isSlashCommand, injected AS injected
    FROM transcriptions
    WHERE text LIKE ?
    ORDER BY timestamp DESC
    LIMIT 100
  `).all(`%${query}%`) as TranscriptionResult[]
}

export function deleteTranscription(id: string): void {
  db.prepare('DELETE FROM transcriptions WHERE id = ?').run(id)
}

export function closeDB(): void {
  if (db?.open) db.close()
}
