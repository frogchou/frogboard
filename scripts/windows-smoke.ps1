# Run on an interactive Windows desktop after npm run package.
# Open the packaged WebView, navigate settings, then close only the test process.
param([string]$Executable = "$PSScriptRoot/../src-tauri/target/release/frogboard.exe")
$ErrorActionPreference = 'Stop'
if (Get-Process -Name frogboard -ErrorAction SilentlyContinue) {
    throw 'Exit the running FrogBoard instance before the smoke test.'
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$path = (Resolve-Path -LiteralPath $Executable).Path
$oldArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$profile = Join-Path ([IO.Path]::GetTempPath()) ("frogboard-ui-" + [guid]::NewGuid())

function Wait-Element([string]$Name, [switch]$Button) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    if ($Button) {
        $type = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)
        $condition = [System.Windows.Automation.AndCondition]::new($condition, $type)
    }
    $limit = [DateTime]::UtcNow.AddSeconds(25)
    do {
        if ($surface) { [Windows.Forms.Application]::DoEvents() }
        $process.Refresh()
        if ($process.HasExited) { throw "FrogBoard exited with $($process.ExitCode)" }
        if ($script:mainHandle -eq [IntPtr]::Zero -and $process.MainWindowTitle -eq '青蛙跳板 · FrogBoard') {
            $script:mainHandle = $process.MainWindowHandle
        }
        if ($script:mainHandle -ne 0) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($script:mainHandle)
            $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
            if ($found) { return $found }
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $limit)
    $type = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    $labels = if ($root) { $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $type) | ForEach-Object { $_.Current.Name } }
    throw "Cannot find control '$Name'. Visible application buttons: $($labels -join ', ')."
}
function Invoke-Button([string]$Name) {
    $button = Wait-Element $Name -Button
    $supported = $button.GetSupportedPatterns().ProgrammaticName
    if ($supported -contains 'InvokePatternIdentifiers.Pattern') {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } elseif ($supported -contains 'ExpandCollapsePatternIdentifiers.Pattern') {
        $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
    } elseif ($supported -contains 'TogglePatternIdentifiers.Pattern') {
        $button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    } else {
        throw "Unsupported button '$Name': $supported"
    }
}
try {
    $script:mainHandle = [IntPtr]::Zero
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    $env:WEBVIEW2_USER_DATA_FOLDER = $profile
    $process = Start-Process -FilePath $path -WindowStyle Hidden -PassThru
    [void](Wait-Element '读取剪贴板')
    Invoke-Button '设置'
    Invoke-Button '模型与动作'
    [void](Wait-Element '添加模型')
    Invoke-Button '提示词操作'
    [void](Wait-Element '添加操作')
    Invoke-Button '返回'
    Invoke-Button '设置'
    Invoke-Button '快捷键与划词'
    [void](Wait-Element '恢复默认值')
    Invoke-Button '返回工作台'
    # Cover the captured monitor with a synthetic surface. Do not save, copy or
    # send user desktop content, or change any existing clipboard formats.
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $surface = New-Object System.Windows.Forms.Form
    $surface.FormBorderStyle = 'None'
    $surface.StartPosition = 'Manual'
    $surface.Bounds = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).Bounds
    $surface.BackColor = [Drawing.Color]::SeaGreen
    $surface.Text = 'FrogBoard capture smoke fixture'
    $surface.Show()
    $surface.Activate()
    $surface.Refresh()
    [Windows.Forms.Application]::DoEvents()
    Invoke-Button '截图标注'
    Invoke-Button '选择全图'
    [void](Wait-Element '椭圆' -Button)
    [void](Wait-Element '文字' -Button)
    [void](Wait-Element '遮盖' -Button)
    Invoke-Button '退出编辑'
    'PASS: packaged workbench, settings, native frozen capture and annotation toolbar.'
} finally {
    if ($surface) { $surface.Close(); $surface.Dispose() }
    if ($process -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldArgs
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldProfile
    if (Test-Path -LiteralPath $profile) {
        $resolved = (Resolve-Path -LiteralPath $profile).Path
        if ([IO.Path]::GetDirectoryName($resolved) -eq ([IO.Path]::GetTempPath()).TrimEnd('\') -and
            [IO.Path]::GetFileName($resolved) -match '^frogboard-ui-[a-f0-9-]{36}$') {
            Remove-Item -LiteralPath $resolved -Force -Recurse -ErrorAction SilentlyContinue
        }
    }
}
