import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs'

const execFile = promisify(execFileCb)
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

export interface CommandResult {
  success: boolean
  message: string
}

// Helper: run AppleScript
async function osascript(script: string): Promise<string> {
  const { stdout } = await execFile('osascript', ['-e', script], { timeout: 10000 })
  return stdout.trim()
}

// Helper: run PowerShell
async function powershell(cmd: string): Promise<string> {
  const { stdout } = await execFile('powershell', ['-Command', cmd], { timeout: 10000 })
  return stdout.trim()
}

// ==================== APP CONTROL ====================

export async function openApp(appName: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await execFile('open', ['-a', appName])
    } else if (isWin) {
      // Try Start-Process first, then fall back to direct execution
      try {
        await powershell(`Start-Process "${appName}"`)
      } catch {
        await powershell(`Start-Process -FilePath "cmd" -ArgumentList "/c start ${appName}"`)
      }
    } else {
      // Linux
      await execFile('xdg-open', [appName]).catch(() =>
        execFile('sh', ['-c', `${appName} &`])
      )
    }
    return { success: true, message: `${appName} 열었어요.` }
  } catch {
    return { success: false, message: `${appName}을 찾지 못했어요.` }
  }
}

export function getPlatformInfo(): { os: string; platform: string } {
  return {
    os: isMac ? 'macOS' : isWin ? 'Windows' : 'Linux',
    platform: process.platform
  }
}

export async function closeApp(appName: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`tell application "${appName}" to quit`)
    } else if (isWin) {
      await powershell(`Stop-Process -Name "${appName}" -Force -ErrorAction SilentlyContinue`)
    }
    return { success: true, message: `${appName} 종료했어요.` }
  } catch {
    return { success: false, message: `${appName} 종료에 실패했어요.` }
  }
}

export async function switchApp(appName: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`tell application "${appName}" to activate`)
    } else if (isWin) {
      await powershell(`(Get-Process "${appName}" -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle | ForEach-Object { [void][System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($_) }`)
    }
    return { success: true, message: `${appName}으로 전환할게요.` }
  } catch {
    return { success: false, message: `${appName} 전환에 실패했어요.` }
  }
}

// ==================== WINDOW CONTROL ====================

export async function minimizeWindow(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          tell process frontApp to set miniaturized of window 1 to true
        end tell`)
    } else if (isWin) {
      await powershell(`
        $shell = New-Object -ComObject Shell.Application
        $shell.MinimizeAll()
      `)
    }
    return { success: true, message: '창 최소화했어요.' }
  } catch {
    return { success: false, message: '창 최소화에 실패했어요.' }
  }
}

export async function maximizeWindow(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          tell process frontApp to set value of attribute "AXFullScreen" of window 1 to true
        end tell`)
    } else if (isWin) {
      await powershell(`
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("{F11}")
      `)
    }
    return { success: true, message: '창 최대화했어요.' }
  } catch {
    return { success: false, message: '창 최대화에 실패했어요.' }
  }
}

// ==================== VOLUME CONTROL ====================

export async function volumeUp(amount = 10): Promise<CommandResult> {
  try {
    if (isMac) {
      const current = await osascript('output volume of (get volume settings)')
      const newVol = Math.min(100, parseInt(current) + amount)
      await osascript(`set volume output volume ${newVol}`)
      return { success: true, message: `볼륨 ${newVol}%` }
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; ${'$'}obj.SendKeys([char]175)`)
      return { success: true, message: '볼륨 올렸어요.' }
    }
    return { success: false, message: '이 플랫폼에서는 지원되지 않아요.' }
  } catch {
    return { success: false, message: '볼륨 조절에 실패했어요.' }
  }
}

export async function volumeDown(amount = 10): Promise<CommandResult> {
  try {
    if (isMac) {
      const current = await osascript('output volume of (get volume settings)')
      const newVol = Math.max(0, parseInt(current) - amount)
      await osascript(`set volume output volume ${newVol}`)
      return { success: true, message: `볼륨 ${newVol}%` }
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; $obj.SendKeys([char]174)`)
      return { success: true, message: '볼륨 낮췄어요.' }
    }
    return { success: true, message: '볼륨 낮췄어요.' }
  } catch {
    return { success: false, message: '볼륨 조절에 실패했어요.' }
  }
}

export async function mute(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('set volume output muted true')
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; $obj.SendKeys([char]173)`)
    }
    return { success: true, message: '음소거했어요.' }
  } catch {
    return { success: false, message: '음소거에 실패했어요.' }
  }
}

export async function unmute(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('set volume output muted false')
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; $obj.SendKeys([char]173)`)
    }
    return { success: true, message: '음소거 해제했어요.' }
  } catch {
    return { success: false, message: '음소거 해제에 실패했어요.' }
  }
}

// ==================== BROWSER ====================

export async function openURL(url: string): Promise<CommandResult> {
  try {
    if (!url.startsWith('http')) url = 'https://' + url
    if (isMac) {
      await execFile('open', [url])
    } else if (isWin) {
      await powershell(`Start-Process "${url}"`)
    } else {
      await execFile('xdg-open', [url])
    }
    return { success: true, message: '링크를 열었어요.' }
  } catch {
    return { success: false, message: '링크를 열지 못했어요.' }
  }
}

export async function webSearch(query: string): Promise<CommandResult> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`
  return openURL(url)
}

export async function newTab(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to keystroke "t" using command down')
    }
    return { success: true, message: '새 탭 열었어요.' }
  } catch {
    return { success: false, message: '새 탭 열기에 실패했어요.' }
  }
}

export async function browserBack(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to keystroke "[" using command down')
    }
    return { success: true, message: '뒤로 갔어요.' }
  } catch {
    return { success: false, message: '뒤로 가기에 실패했어요.' }
  }
}

export async function refreshPage(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to keystroke "r" using command down')
    }
    return { success: true, message: '새로고침했어요.' }
  } catch {
    return { success: false, message: '새로고침에 실패했어요.' }
  }
}

// ==================== SYSTEM ====================

export async function takeScreenshot(): Promise<CommandResult> {
  try {
    const ts = Date.now()
    if (isMac) {
      const p = `/tmp/nova-voice-screenshot-${ts}.png`
      await execFile('screencapture', ['-x', p])
      return { success: true, message: '스크린샷을 저장했어요.' }
    } else if (isWin) {
      const p = `${os.tmpdir()}\\nova-voice-screenshot-${ts}.png`
      await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${p}'); }`)
      return { success: true, message: '스크린샷을 저장했어요.' }
    }
    return { success: false, message: '이 플랫폼에서는 지원되지 않아요.' }
  } catch {
    return { success: false, message: '스크린샷 저장에 실패했어요.' }
  }
}

// ── 눈(Eye): 현재 화면을 캡처하여 base64 반환 (Gemini Vision 입력용) ──
export async function captureScreenBase64(): Promise<string> {
  if (!isMac) throw new Error('captureScreenBase64: macOS 전용')
  const p = `/tmp/nova-voice-screen-${Date.now()}.png`
  await execFile('screencapture', ['-x', p])
  const data = fs.readFileSync(p)
  fs.unlinkSync(p)  // 임시 파일 즉시 삭제 (PNG 1장 2-5MB)
  return data.toString('base64')
}

export async function lockScreen(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to key code 12 using {control down, command down}')
    } else if (isWin) {
      await powershell('rundll32.exe user32.dll, LockWorkStation')
    }
    return { success: true, message: '화면 잠갔어요.' }
  } catch {
    return { success: false, message: '화면 잠금에 실패했어요.' }
  }
}

export async function sleepSystem(): Promise<CommandResult> {
  try {
    if (isMac) {
      await execFile('pmset', ['sleepnow'])
    } else if (isWin) {
      await powershell('Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)')
    }
    return { success: true, message: '절전 모드로 전환할게요.' }
  } catch {
    return { success: false, message: '절전 모드 전환에 실패했어요.' }
  }
}

export async function showNotification(title: string, message: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`)
    } else if (isWin) {
      await powershell(`
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $xml.GetElementsByTagName("text")
        $texts[0].AppendChild($xml.CreateTextNode("${title}")) > $null
        $texts[1].AppendChild($xml.CreateTextNode("${message}")) > $null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("VoiceType").Show($toast)
      `.trim())
    }
    return { success: true, message: '알림을 표시했어요.' }
  } catch {
    return { success: false, message: '알림 표시에 실패했어요.' }
  }
}

export async function openFolder(folderPath: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await execFile('open', [folderPath])
    } else if (isWin) {
      await powershell(`Start-Process explorer.exe "${folderPath}"`)
    } else {
      await execFile('xdg-open', [folderPath])
    }
    return { success: true, message: '폴더를 열었어요.' }
  } catch {
    return { success: false, message: '폴더를 열지 못했어요.' }
  }
}

export async function sendKeystroke(key: string, modifiers: string[] = []): Promise<CommandResult> {
  try {
    if (isMac) {
      const mods = modifiers.map(m => `${m} down`).join(', ')
      const using = mods ? ` using {${mods}}` : ''
      await osascript(`tell application "System Events" to keystroke "${key}"${using}`)
    } else if (isWin) {
      // Map modifiers to PowerShell SendKeys format
      const modMap: Record<string, string> = { 'command': '^', 'control': '^', 'shift': '+', 'alt': '%' }
      const prefix = modifiers.map(m => modMap[m] || '').join('')
      await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${prefix}${key}")`)
    }
    return { success: true, message: '키 입력했어요.' }
  } catch {
    return { success: false, message: '키 입력에 실패했어요.' }
  }
}

// Keyboard shortcut modifier: macOS uses 'command', Windows uses 'control'
export function getPrimaryModifier(): string {
  return isMac ? 'command' : 'control'
}

// ==================== SYSTEM INFO ====================

export async function getMemoryInfo(): Promise<CommandResult> {
  try {
    if (isMac) {
      // vm_stat: 페이지 단위 메모리 정보
      const { stdout: vmstat } = await execFile('vm_stat', [], { timeout: 5000 })
      const pageSize = 16384 // macOS default page size (bytes)
      const wired = parseInt(vmstat.match(/Pages wired down:\s+(\d+)/)?.[1] || '0')
      const active = parseInt(vmstat.match(/Pages active:\s+(\d+)/)?.[1] || '0')
      const inactive = parseInt(vmstat.match(/Pages inactive:\s+(\d+)/)?.[1] || '0')
      const free = parseInt(vmstat.match(/Pages free:\s+(\d+)/)?.[1] || '0')
      const totalPhys = (wired + active + inactive + free) * pageSize
      const usedPhys = (wired + active) * pageSize
      const pct = Math.round(usedPhys / totalPhys * 100)
      const usedGB = Math.round(usedPhys / 1024 / 1024 / 1024)
      const totalGB = Math.round(totalPhys / 1024 / 1024 / 1024)
      return { success: true, message: `메모리 ${pct}% 사용 중이에요. 전체 ${totalGB}기가 중 ${usedGB}기가예요.` }
    } else if (isWin) {
      const out = await powershell('Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json')
      const d = JSON.parse(out)
      const total = d.TotalVisibleMemorySize * 1024
      const free = d.FreePhysicalMemory * 1024
      const used = total - free
      const pct = Math.round(used / total * 100)
      const usedGB = Math.round(used / 1024 / 1024 / 1024)
      const totalGB = Math.round(total / 1024 / 1024 / 1024)
      return { success: true, message: `메모리 ${pct}% 사용 중이에요. 전체 ${totalGB}기가 중 ${usedGB}기가예요.` }
    } else {
      const { stdout } = await execFile('free', ['-b'], { timeout: 5000 })
      const line = stdout.split('\n')[1].split(/\s+/)
      const total = parseInt(line[1])
      const used = parseInt(line[2])
      const pct = Math.round(used / total * 100)
      const totalGB = Math.round(total / 1024 / 1024 / 1024)
      const usedGB = Math.round(used / 1024 / 1024 / 1024)
      return { success: true, message: `메모리 ${pct}% 사용 중이에요. 전체 ${totalGB}기가 중 ${usedGB}기가예요.` }
    }
  } catch (e) {
    return { success: false, message: '메모리 조회에 실패했어요.' }
  }
}

export async function getCpuUsage(): Promise<CommandResult> {
  try {
    if (isMac) {
      const { stdout } = await execFile('top', ['-l', '1', '-s', '0', '-n', '0'], { timeout: 10000 })
      const cpuLine = stdout.match(/CPU usage:\s+([\d.]+)% user,\s+([\d.]+)% sys/)
      if (cpuLine) {
        const total = Math.round(parseFloat(cpuLine[1]) + parseFloat(cpuLine[2]))
        return { success: true, message: `CPU 사용률은 ${total}%예요.` }
      }
    } else if (isWin) {
      const out = await powershell('Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average')
      return { success: true, message: `CPU 사용률은 ${out.trim()}%예요.` }
    }
    return { success: false, message: 'CPU 정보를 조회할 수 없어요.' }
  } catch (e) {
    return { success: false, message: 'CPU 조회에 실패했어요.' }
  }
}

export async function getDiskInfo(): Promise<CommandResult> {
  try {
    if (isMac || process.platform === 'linux') {
      const { stdout } = await execFile('df', ['-h', '/'], { timeout: 5000 })
      const line = stdout.split('\n')[1].split(/\s+/)
      const usePct = line[4]?.replace('%', '') || '?'
      return { success: true, message: `디스크 사용률은 ${usePct}%예요.` }
    } else if (isWin) {
      const out = await powershell('Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json')
      const d = JSON.parse(out)
      const used = Math.round(d.Used / 1024 / 1024 / 1024)
      const total = Math.round((d.Used + d.Free) / 1024 / 1024 / 1024)
      const pct = Math.round(d.Used / (d.Used + d.Free) * 100)
      return { success: true, message: `디스크 ${pct}% 사용 중이에요. 전체 ${total}기가 중 ${used}기가예요.` }
    }
    return { success: false, message: '디스크 정보를 조회할 수 없어요.' }
  } catch (e) {
    return { success: false, message: '디스크 조회에 실패했어요.' }
  }
}

export async function getSystemInfo(): Promise<CommandResult> {
  try {
    const [mem, cpu, disk] = await Promise.all([getMemoryInfo(), getCpuUsage(), getDiskInfo()])
    return { success: true, message: [mem.message, cpu.message, disk.message].join(' ') }
  } catch (e) {
    return { success: false, message: '시스템 정보 조회에 실패했어요.' }
  }
}

// ==================== CALENDAR ====================

export async function getCalendarEvents(period: 'today' | 'tomorrow' | 'week' = 'today'): Promise<CommandResult> {
  try {
    if (!isMac) return { success: false, message: '캘린더는 맥에서만 지원돼요.' }
    const label = period === 'today' ? '오늘' : period === 'tomorrow' ? '내일' : '이번 주'
    const daysAhead = period === 'today' ? 1 : period === 'tomorrow' ? 2 : 7
    const startOffset = period === 'tomorrow' ? 1 : 0
    const script = `
      set startDate to (current date) - (time of (current date)) + ${startOffset} * days
      set endDate to (current date) - (time of (current date)) + ${daysAhead} * days
      tell application "Calendar"
        set allEvents to {}
        repeat with c in calendars
          set evs to every event of c whose start date >= startDate and start date < endDate
          repeat with e in evs
            set end of allEvents to (summary of e & " [" & time string of (start date of e) & "]")
          end repeat
        end repeat
        if length of allEvents = 0 then
          return "${label} 일정이 없어요."
        else
          set AppleScript's text item delimiters to ", "
          return "${label} 일정이에요: " & (allEvents as string)
        end if
      end tell
    `
    const result = await osascript(script)
    return { success: true, message: result }
  } catch (e) {
    return { success: false, message: `캘린더 조회 실패 (Calendar 앱 자동화 권한 필요): ${(e as Error).message}` }
  }
}

export async function addCalendarEvent(title: string, startTime?: string): Promise<CommandResult> {
  try {
    if (!isMac) return { success: false, message: '맥에서만 지원돼요.' }
    const safeTitle = title.replace(/"/g, '\\"')
    const script = `
      tell application "Calendar"
        tell calendar "Calendar"
          set newEvent to make new event at end with properties {summary:"${safeTitle}", start date:(current date) + 1 * days, end date:(current date) + 1 * days + 1 * hours}
        end tell
        reload calendars
      end tell
      return "일정을 추가했어요: ${safeTitle}"
    `
    const result = await osascript(script)
    return { success: true, message: result }
  } catch (e) {
    return { success: false, message: `일정 추가 실패: ${(e as Error).message}` }
  }
}

// ==================== CONTACTS ====================

export async function searchContacts(name: string): Promise<CommandResult> {
  try {
    if (!isMac) return { success: false, message: '맥에서만 지원돼요.' }
    const safeName = name.replace(/"/g, '\\"')
    const script = `
      tell application "Contacts"
        set matches to every person whose name contains "${safeName}"
        if length of matches = 0 then
          return "${safeName} 연락처가 없어요."
        end if
        set info to ""
        repeat with p in matches
          set pName to name of p
          try
            set pPhone to value of first phone of p
          on error
            set pPhone to "(전화 없음)"
          end try
          set info to info & pName & ": " & pPhone & return
        end repeat
        return info
      end tell
    `
    const result = await osascript(script)
    return { success: true, message: result.trim() }
  } catch (e) {
    return { success: false, message: `연락처 검색 실패 (연락처 앱 권한 필요): ${(e as Error).message}` }
  }
}

// ==================== WEATHER ====================

export async function getWeather(location = '서울'): Promise<CommandResult> {
  try {
    // wttr.in — free, no API key, plain text output
    const { stdout } = await execFile('curl', [
      '-s', '--max-time', '8',
      `https://wttr.in/${encodeURIComponent(location)}?format=%l:+%C+%t+(%f)+습도+%h+바람+%w&lang=ko`
    ], { timeout: 10000 })
    if (stdout.trim()) {
      return { success: true, message: stdout.trim() }
    }
    throw new Error('empty response')
  } catch (e) {
    return { success: false, message: `날씨 조회 실패: ${(e as Error).message}` }
  }
}

// ==================== REMINDERS ====================

export async function addReminder(title: string, dueDate?: string): Promise<CommandResult> {
  try {
    if (!isMac) return { success: false, message: '맥에서만 지원돼요.' }
    const safeTitle = title.replace(/"/g, '\\"')
    const script = dueDate
      ? `tell application "Reminders" to make new reminder with properties {name:"${safeTitle}", due date:date "${dueDate}"}`
      : `tell application "Reminders" to make new reminder with properties {name:"${safeTitle}"}`
    await osascript(script)
    return { success: true, message: `리마인더 추가했어요: "${title}"` }
  } catch (e) {
    return { success: false, message: `리마인더 추가 실패: ${(e as Error).message}` }
  }
}
