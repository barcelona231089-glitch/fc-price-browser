$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument '"C:\Users\barce\FCTraderBrain\world-max-worker\start-world-max-hidden.vbs"'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName 'FC World Max Worker' -Action $action -Trigger $trigger -Settings $settings -Description 'Self-healing CUDA Chronos-2 World-Max worker and Cloudflare registry updater' -Force | Out-Null
