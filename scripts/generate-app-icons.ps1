$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PublicDir = Join-Path $RootDir "public"
$PngPath = Join-Path $PublicDir "app-icon-256.png"
$IcoPath = Join-Path $PublicDir "app-icon.ico"

Add-Type -AssemblyName System.Drawing

$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-Brush {
  param([string] $Hex)
  return New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($Hex))
}

function Fill-RoundedRect {
  param(
    [System.Drawing.Graphics] $Graphics,
    [System.Drawing.Brush] $Brush,
    [float] $X,
    [float] $Y,
    [float] $Width,
    [float] $Height,
    [float] $Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  $Graphics.FillPath($Brush, $path)
  $path.Dispose()
}

$bg = New-Brush "#090c12"
$panel = New-Brush "#10151e"
$faint = New-Brush "#66718a"
$dim = New-Brush "#9aa6b6"
$text = New-Brush "#eaeef5"

Fill-RoundedRect $graphics $bg 0 0 256 256 56
Fill-RoundedRect $graphics $panel 28 28 200 200 44
Fill-RoundedRect $graphics $faint 54 144 38 64 14
Fill-RoundedRect $graphics $dim 109 101 38 107 14
Fill-RoundedRect $graphics $text 164 48 38 160 14

$bitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$pngBytes = [System.IO.File]::ReadAllBytes($PngPath)
$stream = New-Object System.IO.FileStream($IcoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter($stream)

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)

$writer.Dispose()
$stream.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$bg.Dispose()
$panel.Dispose()
$faint.Dispose()
$dim.Dispose()
$text.Dispose()

Write-Host "Generated $PngPath"
Write-Host "Generated $IcoPath"
