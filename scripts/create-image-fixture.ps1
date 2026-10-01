Add-Type -AssemblyName System.Drawing
$fixtureDirectory = Join-Path $PSScriptRoot '../.local'
[System.IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 360,220
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font 'Arial',24
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('IMG-8426', $font, [System.Drawing.Brushes]::Black, 25,20)
  $graphics.FillRectangle([System.Drawing.Brushes]::Green, 30,90,140,85)
  $graphics.FillEllipse([System.Drawing.Brushes]::Red, 230,90,85,85)
  $bitmap.Save((Join-Path $fixtureDirectory 'image-fixture.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $font.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
