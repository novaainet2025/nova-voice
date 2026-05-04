import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import os from 'os'

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
    return { success: true, message: `${appName} 열기 완료` }
  } catch {
    return { success: false, message: `${appName}을(를) 찾을 수 없습니다` }
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
    return { success: true, message: `${appName} 종료 완료` }
  } catch {
    return { success: false, message: `${appName} 종료 실패` }
  }
}

export async function switchApp(appName: string): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript(`tell application "${appName}" to activate`)
    } else if (isWin) {
      await powershell(`(Get-Process "${appName}" -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle | ForEach-Object { [void][System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($_) }`)
    }
    return { success: true, message: `${appName}(으)로 전환` }
  } catch {
    return { success: false, message: `${appName} 전환 실패` }
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
    return { success: true, message: '창 최소화 완료' }
  } catch {
    return { success: false, message: '최소화 실패' }
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
    return { success: true, message: '창 최대화 완료' }
  } catch {
    return { success: false, message: '최대화 실패' }
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
      return { success: true, message: '볼륨 올림' }
    }
    return { success: false, message: '지원되지 않는 플랫폼' }
  } catch {
    return { success: false, message: '볼륨 조절 실패' }
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
      return { success: true, message: '볼륨 내림' }
    }
    return { success: true, message: '볼륨 내림' }
  } catch {
    return { success: false, message: '볼륨 조절 실패' }
  }
}

export async function mute(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('set volume output muted true')
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; $obj.SendKeys([char]173)`)
    }
    return { success: true, message: '음소거' }
  } catch {
    return { success: false, message: '음소거 실패' }
  }
}

export async function unmute(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('set volume output muted false')
    } else if (isWin) {
      await powershell(`$obj = New-Object -com wscript.shell; $obj.SendKeys([char]173)`)
    }
    return { success: true, message: '음소거 해제' }
  } catch {
    return { success: false, message: '음소거 해제 실패' }
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
    return { success: true, message: `${url} 열기` }
  } catch {
    return { success: false, message: 'URL 열기 실패' }
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
    return { success: true, message: '새 탭' }
  } catch {
    return { success: false, message: '새 탭 실패' }
  }
}

export async function browserBack(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to keystroke "[" using command down')
    }
    return { success: true, message: '뒤로 가기' }
  } catch {
    return { success: false, message: '실패' }
  }
}

export async function refreshPage(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to keystroke "r" using command down')
    }
    return { success: true, message: '새로고침' }
  } catch {
    return { success: false, message: '새로고침 실패' }
  }
}

// ==================== SYSTEM ====================

export async function takeScreenshot(): Promise<CommandResult> {
  try {
    const ts = Date.now()
    if (isMac) {
      const p = `/tmp/nova-voice-screenshot-${ts}.png`
      await execFile('screencapture', ['-x', p])
      return { success: true, message: `스크린샷 저장: ${p}` }
    } else if (isWin) {
      const p = `${os.tmpdir()}\\nova-voice-screenshot-${ts}.png`
      await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${p}'); }`)
      return { success: true, message: `스크린샷 저장: ${p}` }
    }
    return { success: false, message: '지원되지 않는 플랫폼' }
  } catch {
    return { success: false, message: '스크린샷 실패' }
  }
}

export async function lockScreen(): Promise<CommandResult> {
  try {
    if (isMac) {
      await osascript('tell application "System Events" to key code 12 using {control down, command down}')
    } else if (isWin) {
      await powershell('rundll32.exe user32.dll, LockWorkStation')
    }
    return { success: true, message: '화면 잠금' }
  } catch {
    return { success: false, message: '잠금 실패' }
  }
}

export async function sleepSystem(): Promise<CommandResult> {
  try {
    if (isMac) {
      await execFile('pmset', ['sleepnow'])
    } else if (isWin) {
      await powershell('Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)')
    }
    return { success: true, message: '절전 모드' }
  } catch {
    return { success: false, message: '절전 실패' }
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
    return { success: true, message: '알림 표시' }
  } catch {
    return { success: false, message: '알림 실패' }
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
    return { success: true, message: `${folderPath} 열기` }
  } catch {
    return { success: false, message: '폴더 열기 실패' }
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
    return { success: true, message: `키 입력: ${modifiers.join('+')}+${key}` }
  } catch {
    return { success: false, message: '키 입력 실패' }
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
      const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1)
      const pct = Math.round(usedPhys / totalPhys * 100)
      return { success: true, message: `메모리: ${toGB(usedPhys)}GB 사용 / ${toGB(totalPhys)}GB (${pct}%)` }
    } else if (isWin) {
      const out = await powershell('Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json')
      const d = JSON.parse(out)
      const total = d.TotalVisibleMemorySize * 1024
      const free = d.FreePhysicalMemory * 1024
      const used = total - free
      const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1)
      return { success: true, message: `메모리: ${toGB(used)}GB 사용 / ${toGB(total)}GB` }
    } else {
      const { stdout } = await execFile('free', ['-b'], { timeout: 5000 })
      const line = stdout.split('\n')[1].split(/\s+/)
      const total = parseInt(line[1])
      const used = parseInt(line[2])
      const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1)
      return { success: true, message: `메모리: ${toGB(used)}GB 사용 / ${toGB(total)}GB` }
    }
  } catch (e) {
    return { success: false, message: `메모리 조회 실패: ${(e as Error).message}` }
  }
}

export async function getCpuUsage(): Promise<CommandResult> {
  try {
    if (isMac) {
      const { stdout } = await execFile('top', ['-l', '1', '-s', '0', '-n', '0'], { timeout: 10000 })
      const cpuLine = stdout.match(/CPU usage:\s+([\d.]+)% user,\s+([\d.]+)% sys/)
      if (cpuLine) {
        const total = (parseFloat(cpuLine[1]) + parseFloat(cpuLine[2])).toFixed(1)
        return { success: true, message: `CPU 사용률: ${total}%` }
      }
    } else if (isWin) {
      const out = await powershell('Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average')
      return { success: true, message: `CPU 사용률: ${out.trim()}%` }
    }
    return { success: false, message: 'CPU 조회 미지원' }
  } catch (e) {
    return { success: false, message: `CPU 조회 실패: ${(e as Error).message}` }
  }
}

export async function getDiskInfo(): Promise<CommandResult> {
  try {
    if (isMac || process.platform === 'linux') {
      const { stdout } = await execFile('df', ['-h', '/'], { timeout: 5000 })
      const line = stdout.split('\n')[1].split(/\s+/)
      return { success: true, message: `디스크(/): ${line[2]} 사용 / ${line[1]} (${line[4]})` }
    } else if (isWin) {
      const out = await powershell('Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json')
      const d = JSON.parse(out)
      const used = (d.Used / 1024 / 1024 / 1024).toFixed(1)
      const total = ((d.Used + d.Free) / 1024 / 1024 / 1024).toFixed(1)
      return { success: true, message: `디스크(C:): ${used}GB 사용 / ${total}GB` }
    }
    return { success: false, message: '디스크 조회 미지원' }
  } catch (e) {
    return { success: false, message: `디스크 조회 실패: ${(e as Error).message}` }
  }
}

export async function getSystemInfo(): Promise<CommandResult> {
  try {
    const [mem, cpu, disk] = await Promise.all([getMemoryInfo(), getCpuUsage(), getDiskInfo()])
    return { success: true, message: [mem.message, cpu.message, disk.message].join(' | ') }
  } catch (e) {
    return { success: false, message: `시스템 정보 조회 실패: ${(e as Error).message}` }
  }
}
