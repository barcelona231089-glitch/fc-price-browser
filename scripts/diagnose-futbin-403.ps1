$ErrorActionPreference='Continue';
$targets=@(
  'https://www.futbin.com/27/players',
  'https://www.futbin.com/27/player/506',
  'https://www.futbin.org/futbin/api/27/getPlayersPrice?player_ids=506&platform=PS'
);
foreach($url in $targets){
  Write-Host ('== '+$url);
  try {
    $response=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 12 -MaximumRedirection 3;
    $status=[int]$response.StatusCode;
  }catch {
    $response=$_.Exception.Response;
    $status=if($response){[int]$response.StatusCode}else{'NETWORK_ERROR'};
  }
  Write-Host ('HTTP='+$status);
  if($response){
    Write-Host ('Content-Type='+$response.Headers['Content-Type']);
    Write-Host ('Server='+$response.Headers['Server']);
    Write-Host ('CF-Ray='+$response.Headers['CF-Ray']);
    Write-Host ('Location='+$response.Headers['Location']);
    Write-Host ('Retry-After='+$response.Headers['Retry-After']);
    Write-Host ('WWW-Authenticate='+[bool]$response.Headers['WWW-Authenticate']);
    try {
      $body=$response.Content;
      if(-not $body -and $response.GetResponseStream){
        $reader=New-Object System.IO.StreamReader($response.GetResponseStream());
        $body=$reader.ReadToEnd();
        $reader.Dispose();
      }
      $body=[regex]::Replace([string]$body,'\s+',' ');
      if($body.Length -gt 350){$body=$body.Substring(0,350)}
      Write-Host ('BODY='+$body);
    } catch {Write-Host ('Body read failed: '+$_.Exception.GetType().Name)}
  }
}