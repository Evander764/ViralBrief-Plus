// 桌面微信视频号巡检的 Swift 助手：把原本一条条 `swift -e <源码>` 解释执行的截图分析与
// 鼠标控制，合并成「一个带子命令的 Swift 程序」，用 swiftc -O 编译成二进制并缓存，之后每次只
// 启动二进制（~30ms），而不是反复解释执行（每次像素扫描 ~2.5s）。这是视频号巡检卡顿的根因修复。
//
// 关键提速点：图像分析不再用 NSBitmapImageRep.colorAt（每像素分配 NSColor，编译后仍 ~2s），改为
// 一次性把 CGImage 画进 deviceRGB 的 RGBA8 缓冲区，再直接读字节（同样的 Retina 全屏 ~30-40ms）。
// 经验证：缓冲区与 colorAt 的坐标系一致（y=0 在顶部，无翻转），luma 仅有 <0.08 的细微 gamma 偏移，
// 对这里全部「粗粒度阈值」启发式无影响。
//
// 设计约束（见 CLAUDE.md）：零 npm 依赖、不引入 Python、不接视觉大模型或文字识别。swiftc/swift 是
// macOS 自带工具链，与原方案一致。若 swiftc 不可用或编译失败，回退到解释执行同一份源码，保证不硬失败。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';

const execFileAsync = promisify(execFile);

// 单一 Swift 程序：argv[1] 是子命令。控制类命令（click/move/wiggle/scroll/cgwin）不读图片直接执行；
// 图像类命令先把 PNG 画进 deviceRGB 缓冲区，再跑与旧版逐像素一致的算法，输出同样形状的 JSON。
const HELPER_SOURCE = String.raw`import AppKit
import CoreGraphics
import Foundation
import Darwin

let ARGS = CommandLine.arguments
func argS(_ i: Int) -> String { return i < ARGS.count ? ARGS[i] : "" }
func argD(_ i: Int) -> Double { return Double(argS(i)) ?? 0 }
let cmd = argS(1)

let evSource = CGEventSource(stateID: .hidSystemState)
func mouse(_ type: CGEventType, _ x: Double, _ y: Double) {
  if let e = CGEvent(mouseEventSource: evSource, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
    e.post(tap: .cghidEventTap)
  }
}

if cmd == "click" {
  let x = argD(2), y = argD(3)
  mouse(.mouseMoved, x, y); usleep(80_000)
  mouse(.leftMouseDown, x, y); usleep(90_000)
  mouse(.leftMouseUp, x, y)
  exit(0)
}
if cmd == "move" {
  mouse(.mouseMoved, argD(2), argD(3)); usleep(180_000); exit(0)
}
if cmd == "wiggle" {
  let x = argD(2), y = argD(3)
  for dx in [-18.0, 18.0, -10.0, 10.0, 0.0] { mouse(.mouseMoved, x + dx, y); usleep(70_000) }
  exit(0)
}
if cmd == "scroll" {
  let x = argD(2), y = argD(3)
  let dy = Int32(argS(4)) ?? 0
  mouse(.mouseMoved, x, y); usleep(80_000)
  if let e = CGEvent(scrollWheelEvent2Source: evSource, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) {
    e.post(tap: .cghidEventTap)
  }
  usleep(120_000)
  exit(0)
}
if cmd == "cgwin" {
  let list = (CGWindowListCopyWindowInfo(CGWindowListOption(arrayLiteral: .optionAll), kCGNullWindowID) as? [[String: Any]]) ?? []
  var protectedLarge = false
  var sharedLarge = false
  for window in list {
    let owner = (window[kCGWindowOwnerName as String] as? String) ?? ""
    if !(owner.localizedCaseInsensitiveContains("wechat") || owner.contains("微信")) { continue }
    let layer = (window[kCGWindowLayer as String] as? Int) ?? 0
    if layer != 0 { continue }
    let sharing = (window[kCGWindowSharingState as String] as? Int) ?? -1
    let b = (window[kCGWindowBounds as String] as? [String: Any]) ?? [:]
    let x = (b["X"] as? Double) ?? 0
    let y = (b["Y"] as? Double) ?? 0
    let w = (b["Width"] as? Double) ?? 0
    let h = (b["Height"] as? Double) ?? 0
    if x >= 0 && y >= 0 && w >= 500 && h >= 350 {
      if sharing == 0 { protectedLarge = true }
      if sharing == 1 { sharedLarge = true }
    }
  }
  print((protectedLarge ? "1" : "0") + "|" + (sharedLarge ? "1" : "0"))
  exit(0)
}

// ---- 以下为图像类命令，先加载并解码到 deviceRGB 缓冲区 ----
let imgPath = argS(2)
func dieDefault() -> Never {
  if cmd == "channels-window" { print("{}") }
  else if cmd == "already" || cmd == "selected" { print("{\"ok\":false}") }
  else if cmd == "leftrail" { print("{\"clusters\":[]}") }
  else if cmd == "fingerprint" { print("") }
  else { print("[]") }
  exit(0)
}
guard let imgData = try? Data(contentsOf: URL(fileURLWithPath: imgPath)),
      let rep = NSBitmapImageRep(data: imgData),
      let cgImage = rep.cgImage else { dieDefault() }

let pxWidth = cgImage.width
let pxHeight = cgImage.height
let colorSpace = NSColorSpace.deviceRGB.cgColorSpace ?? CGColorSpaceCreateDeviceRGB()
let bytesPerRow = pxWidth * 4
var pixelBuf = [UInt8](repeating: 0, count: bytesPerRow * pxHeight)
guard let drawCtx = pixelBuf.withUnsafeMutableBytes({ raw in
  CGContext(data: raw.baseAddress, width: pxWidth, height: pxHeight, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
}) else { dieDefault() }
drawCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: pxWidth, height: pxHeight))

// 直接读字节：截图为不透明，premultipliedLast 与直通一致；坐标系 y=0 在顶部，与旧 colorAt 完全对齐。
@inline(__always) func RGBA(_ x: Int, _ y: Int) -> (Double, Double, Double, Double) {
  let p = y * bytesPerRow + x * 4
  return (Double(pixelBuf[p]) / 255.0, Double(pixelBuf[p + 1]) / 255.0, Double(pixelBuf[p + 2]) / 255.0, Double(pixelBuf[p + 3]) / 255.0)
}

let displayBounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(pxWidth) / max(Double(displayBounds.width), 1.0)
let scaleY = Double(pxHeight) / max(Double(displayBounds.height), 1.0)
func pixelX(_ x: Double) -> Int { return min(pxWidth - 1, max(0, Int(((x - Double(displayBounds.minX)) * scaleX).rounded()))) }
func pixelY(_ y: Double) -> Int { return min(pxHeight - 1, max(0, Int(((y - Double(displayBounds.minY)) * scaleY).rounded()))) }

func emit(_ obj: Any) {
  let json = try! JSONSerialization.data(withJSONObject: obj, options: [])
  print(String(data: json, encoding: .utf8)!)
}

if cmd == "creator-cards" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let xStart = pixelX(wx + max(170.0, ww * 0.15))
  let xEnd = pixelX(wx + ww - 46.0)
  let yStart = pixelY(wy + 150.0)
  let yEnd = pixelY(wy + wh - 70.0)
  let cropW = max(0, xEnd - xStart + 1)
  let cropH = max(0, yEnd - yStart + 1)
  if cropW <= 0 || cropH <= 0 { print("[]"); exit(0) }

  var rowCounts = Array(repeating: 0, count: cropH)
  var rowMinX = Array(repeating: Int.max, count: cropH)
  var rowMaxX = Array(repeating: 0, count: cropH)
  for cy in 0..<cropH {
    for cx in stride(from: 0, to: cropW, by: 2) {
      let x = xStart + cx
      let y = yStart + cy
      let (r, g, b, a) = RGBA(x, y)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      let chroma = max(r, max(g, b)) - min(r, min(g, b))
      if a > 0.7 && (luma < 0.88 || chroma > 0.08) {
        rowCounts[cy] += 1
        rowMinX[cy] = min(rowMinX[cy], x)
        rowMaxX[cy] = max(rowMaxX[cy], x)
      }
    }
  }

  let threshold = max(24, cropW / 28)
  var bands: [(start: Int, end: Int, minX: Int, maxX: Int, pixels: Int)] = []
  var start = -1
  var end = -1
  var minX = Int.max
  var maxX = 0
  var pixels = 0
  var gap = 0
  func flush() {
    if start < 0 || end < start { return }
    let hPts = Double(end - start + 1) / max(scaleY, 0.01)
    let wPts = Double(maxX - minX + 1) / max(scaleX, 0.01)
    if hPts >= 70.0 && wPts >= 70.0 && pixels >= 450 {
      bands.append((start, end, minX, maxX, pixels))
    }
  }
  for i in 0..<cropH {
    if rowCounts[i] >= threshold {
      if start < 0 { start = i }
      end = i
      minX = min(minX, rowMinX[i])
      maxX = max(maxX, rowMaxX[i])
      pixels += rowCounts[i]
      gap = 0
    } else if start >= 0 {
      gap += 1
      if gap > 8 {
        flush()
        start = -1
        end = -1
        minX = Int.max
        maxX = 0
        pixels = 0
        gap = 0
      }
    }
  }
  flush()

  func pinnedScore(minX: Int, maxX: Int, startY: Int, endY: Int) -> Double {
    let w = maxX - minX + 1
    let h = endY - startY + 1
    if w <= 20 || h <= 20 { return 0.0 }
    let px0 = min(pxWidth - 1, max(0, maxX - max(22, w / 5)))
    let px1 = min(pxWidth - 1, max(0, maxX - 4))
    let py0 = min(pxHeight - 1, max(0, startY + Int(Double(h) * 0.58)))
    let py1 = min(pxHeight - 1, max(0, endY - 4))
    var bright = 0
    var horizontalRows = 0
    if px0 > px1 || py0 > py1 { return 0.0 }
    for y in py0...py1 {
      var rowBright = 0
      for x in px0...px1 {
        let (r, g, b, a) = RGBA(x, y)
        let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
        if a > 0.7 && luma > 0.72 && max(r, max(g, b)) - min(r, min(g, b)) < 0.25 {
          bright += 1
          rowBright += 1
        }
      }
      if rowBright >= max(6, (px1 - px0 + 1) / 3) { horizontalRows += 1 }
    }
    return min(1.0, (Double(bright) / 70.0) + (Double(horizontalRows) / 18.0))
  }

  var cards: [[String: Any]] = []
  for band in bands {
    let hPts = Double(band.end - band.start + 1) / max(scaleY, 0.01)
    let wPts = Double(band.maxX - band.minX + 1) / max(scaleX, 0.01)
    let centerX = Double(displayBounds.minX) + Double(band.minX + band.maxX) / 2.0 / scaleX
    let centerY = Double(displayBounds.minY) + Double(yStart + band.start + yStart + band.end) / 2.0 / scaleY
    let pin = pinnedScore(minX: band.minX, maxX: band.maxX, startY: yStart + band.start, endY: yStart + band.end)
    cards.append([
      "x": centerX,
      "y": centerY,
      "width": wPts,
      "height": hPts,
      "confidence": min(0.96, max(0.55, Double(band.pixels) / 1800.0)),
      "pinned": pin >= 0.55,
      "pinScore": pin,
      "source": "screenshot"
    ])
  }
  cards.sort { a, b in
    let ay = a["y"] as? Double ?? 0
    let by = b["y"] as? Double ?? 0
    if abs(ay - by) > 36 { return ay < by }
    return (a["x"] as? Double ?? 0) < (b["x"] as? Double ?? 0)
  }
  emit(cards)
  exit(0)
}

if cmd == "next-arrow" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let xStart = pixelX(wx + ww * 0.70)
  let xEnd = pixelX(wx + ww - 24.0)
  let yStart = pixelY(wy + wh * 0.30)
  let yEnd = pixelY(wy + wh * 0.84)
  let cropW = max(0, xEnd - xStart + 1)
  let cropH = max(0, yEnd - yStart + 1)
  if cropW <= 0 || cropH <= 0 { print("[]"); exit(0) }

  var mask = Array(repeating: false, count: cropW * cropH)
  func idx(_ x: Int, _ y: Int) -> Int { return y * cropW + x }
  for cy in 0..<cropH {
    for cx in 0..<cropW {
      let x = xStart + cx
      let y = yStart + cy
      let (r, g, b, a) = RGBA(x, y)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma > 0.52 && luma < 0.98 && max(r, max(g, b)) - min(r, min(g, b)) < 0.30 {
        mask[idx(cx, cy)] = true
      }
    }
  }

  var visited = Array(repeating: false, count: cropW * cropH)
  let dirs = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
  var candidates: [[String: Any]] = []
  for sy in 0..<cropH {
    for sx in 0..<cropW {
      let startIndex = idx(sx, sy)
      if visited[startIndex] || !mask[startIndex] { continue }
      var stack = [(sx, sy)]
      visited[startIndex] = true
      var pts: [(Int, Int)] = []
      var minX = sx
      var maxX = sx
      var minY = sy
      var maxY = sy
      while let (px, py) = stack.popLast() {
        pts.append((px, py))
        minX = min(minX, px)
        maxX = max(maxX, px)
        minY = min(minY, py)
        maxY = max(maxY, py)
        for (dx, dy) in dirs {
          let nx = px + dx
          let ny = py + dy
          if nx < 0 || ny < 0 || nx >= cropW || ny >= cropH { continue }
          let ni = idx(nx, ny)
          if visited[ni] || !mask[ni] { continue }
          visited[ni] = true
          stack.append((nx, ny))
        }
      }
      let count = pts.count
      if count < 12 { continue }
      let boxW = maxX - minX + 1
      let boxH = maxY - minY + 1
      let wPts = Double(boxW) / max(scaleX, 0.01)
      let hPts = Double(boxH) / max(scaleY, 0.01)
      if wPts < 8.0 || wPts > 72.0 || hPts < 8.0 || hPts > 72.0 { continue }
      var lower = 0
      var upper = 0
      for (_, py) in pts {
        if py > minY + boxH / 2 { lower += 1 } else { upper += 1 }
      }
      let lowerRatio = Double(lower) / Double(max(count, 1))
      let direction = lowerRatio >= 0.47 ? "down" : "up"
      let density = Double(count) / Double(max(1, boxW * boxH))
      let score = min(0.95, max(0.0, density + min(wPts, hPts) / 80.0 + (direction == "down" ? 0.08 : 0.0)))
      candidates.append([
        "x": Double(displayBounds.minX) + Double(xStart + minX + boxW / 2) / scaleX,
        "y": Double(displayBounds.minY) + Double(yStart + minY + boxH / 2) / scaleY,
        "width": wPts,
        "height": hPts,
        "score": score,
        "direction": direction
      ])
    }
  }
  emit(candidates)
  exit(0)
}

if cmd == "channels-window" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let xStart = pixelX(wx + ww * 0.04)
  let xEnd = pixelX(wx + ww * 0.96)
  let yStart = pixelY(wy + 82.0)
  let yEnd = pixelY(wy + wh - 95.0)
  var total = 0
  var black = 0
  var dark = 0
  var bright = 0
  var mid = 0
  if xStart <= xEnd && yStart <= yEnd {
    for y in stride(from: yStart, through: yEnd, by: 3) {
      for x in stride(from: xStart, through: xEnd, by: 3) {
        total += 1
        let (r, g, b, a) = RGBA(x, y)
        let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
        if a > 0.7 && luma < 0.05 { black += 1 }
        if a > 0.7 && luma < 0.16 { dark += 1 }
        if a > 0.7 && luma > 0.78 { bright += 1 }
        if a > 0.7 && luma > 0.22 && luma < 0.72 { mid += 1 }
      }
    }
  }
  let totalD = max(Double(total), 1.0)
  emit([
    "bodyTotal": total,
    "bodyBlackRatio": Double(black) / totalD,
    "bodyDarkRatio": Double(dark) / totalD,
    "bodyBrightRatio": Double(bright) / totalD,
    "bodyMidRatio": Double(mid) / totalD,
    "scaleX": scaleX,
    "scaleY": scaleY,
    "sampleRect": String(xStart) + "," + String(yStart) + "," + String(xEnd - xStart) + "," + String(yEnd - yStart)
  ])
  exit(0)
}

if cmd == "fingerprint" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let gx = 7
  let gy = 7
  var parts: [String] = []
  for yy in 0..<gy {
    for xx in 0..<gx {
      let x0 = pixelX(wx + ww * (0.18 + 0.68 * Double(xx) / Double(gx)))
      let x1 = pixelX(wx + ww * (0.18 + 0.68 * Double(xx + 1) / Double(gx)))
      let y0 = pixelY(wy + wh * (0.16 + 0.70 * Double(yy) / Double(gy)))
      let y1 = pixelY(wy + wh * (0.16 + 0.70 * Double(yy + 1) / Double(gy)))
      var sum = 0.0
      var count = 0.0
      if x0 <= x1 && y0 <= y1 {
        for y in stride(from: y0, through: y1, by: 4) {
          for x in stride(from: x0, through: x1, by: 4) {
            let (r, g, b, _) = RGBA(x, y)
            let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
            sum += luma
            count += 1
          }
        }
      }
      parts.append(String(Int(((sum / max(count, 1.0)) * 9.0).rounded())))
    }
  }
  print(parts.joined())
  exit(0)
}

if cmd == "sidebar-rows" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let xStart = pixelX(wx + 20.0)
  let xEnd = pixelX(wx + min(190.0, max(130.0, ww * 0.13)))
  let yStart = pixelY(wy + 105.0)
  let yEnd = pixelY(min(wy + wh - 120.0, wy + 470.0))
  let rowCount = max(0, yEnd - yStart + 1)
  var counts = Array(repeating: 0, count: rowCount)
  var minXs = Array(repeating: Int.max, count: rowCount)
  var maxXs = Array(repeating: 0, count: rowCount)
  var sumXs = Array(repeating: 0.0, count: rowCount)
  if xStart <= xEnd && yStart <= yEnd {
    for y in yStart...yEnd {
      let row = y - yStart
      for x in xStart...xEnd {
        let (r, g, b, a) = RGBA(x, y)
        let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
        if a > 0.7 && luma < 0.82 && max(r, max(g, b)) < 0.90 {
          counts[row] += 1
          minXs[row] = min(minXs[row], x)
          maxXs[row] = max(maxXs[row], x)
          sumXs[row] += Double(x)
        }
      }
    }
  }

  let threshold = max(5, Int(Double(max(1, xEnd - xStart + 1)) * 0.012))
  let maxGap = max(3, Int((6.0 * scaleY).rounded()))
  var rows: [[String: Any]] = []
  var start = -1
  var end = -1
  var gap = 0
  func flushSegment() {
    if start < 0 || end < start { return }
    var total = 0
    var weightedY = 0.0
    var weightedX = 0.0
    var minX = Int.max
    var maxX = 0
    for i in start...end {
      total += counts[i]
      weightedY += Double(yStart + i) * Double(counts[i])
      weightedX += sumXs[i]
      if counts[i] > 0 {
        minX = min(minX, minXs[i])
        maxX = max(maxX, maxXs[i])
      }
    }
    if total <= 0 { return }
    let heightPts = Double(end - start + 1) / max(scaleY, 0.01)
    let widthPts = Double(maxX - minX + 1) / max(scaleX, 0.01)
    if heightPts >= 8.0 && heightPts <= 36.0 && widthPts >= 18.0 && total >= 40 {
      rows.append([
        "centerX": Double(displayBounds.minX) + (weightedX / Double(total)) / scaleX,
        "centerY": Double(displayBounds.minY) + (weightedY / Double(total)) / scaleY,
        "width": widthPts,
        "height": heightPts,
        "darkPixels": total
      ])
    }
  }
  for i in 0..<rowCount {
    if counts[i] > threshold {
      if start < 0 { start = i }
      end = i
      gap = 0
    } else if start >= 0 {
      gap += 1
      if gap > maxGap {
        flushSegment()
        start = -1
        end = -1
        gap = 0
      }
    }
  }
  flushSegment()
  emit(rows)
  exit(0)
}

if cmd == "tab-close" {
  let wx = argD(3), wy = argD(4), ww = argD(5), wh = argD(6)
  let xStart = pixelX(wx + min(250.0, ww * 0.20))
  let xEnd = pixelX(wx + min(ww - 120.0, ww * 0.82))
  let yStart = pixelY(wy + 15.0)
  let yEnd = pixelY(wy + 72.0)
  let cropWidth = max(0, xEnd - xStart + 1)
  let cropHeight = max(0, yEnd - yStart + 1)
  if cropWidth <= 0 || cropHeight <= 0 { print("[]"); exit(0) }

  var mask = Array(repeating: false, count: cropWidth * cropHeight)
  func idx(_ x: Int, _ y: Int) -> Int { return y * cropWidth + x }
  for cy in 0..<cropHeight {
    for cx in 0..<cropWidth {
      let x = xStart + cx
      let y = yStart + cy
      let (r, g, b, a) = RGBA(x, y)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma < 0.48 && max(r, max(g, b)) < 0.65 {
        mask[idx(cx, cy)] = true
      }
    }
  }

  var visited = Array(repeating: false, count: cropWidth * cropHeight)
  let dirs = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
  var candidates: [[String: Any]] = []
  for sy in 0..<cropHeight {
    for sx in 0..<cropWidth {
      let startIndex = idx(sx, sy)
      if visited[startIndex] || !mask[startIndex] { continue }
      var stack = [(sx, sy)]
      var pts: [(Int, Int)] = []
      visited[startIndex] = true
      var minX = sx
      var maxX = sx
      var minY = sy
      var maxY = sy
      while let (px, py) = stack.popLast() {
        pts.append((px, py))
        minX = min(minX, px)
        maxX = max(maxX, px)
        minY = min(minY, py)
        maxY = max(maxY, py)
        for (dx, dy) in dirs {
          let nx = px + dx
          let ny = py + dy
          if nx < 0 || ny < 0 || nx >= cropWidth || ny >= cropHeight { continue }
          let ni = idx(nx, ny)
          if visited[ni] || !mask[ni] { continue }
          visited[ni] = true
          stack.append((nx, ny))
        }
      }
      let count = pts.count
      if count < 12 { continue }
      let boxW = maxX - minX + 1
      let boxH = maxY - minY + 1
      let wPts = Double(boxW) / max(scaleX, 0.01)
      let hPts = Double(boxH) / max(scaleY, 0.01)
      if wPts < 6.0 || wPts > 22.0 || hPts < 6.0 || hPts > 22.0 { continue }
      let aspect = wPts / max(hPts, 0.01)
      if aspect < 0.55 || aspect > 1.65 { continue }
      var diag = 0
      var anti = 0
      for (px, py) in pts {
        let nx = Double(px - minX) / max(Double(boxW - 1), 1.0)
        let ny = Double(py - minY) / max(Double(boxH - 1), 1.0)
        if abs(nx - ny) < 0.24 { diag += 1 }
        if abs((1.0 - nx) - ny) < 0.24 { anti += 1 }
      }
      let density = Double(count) / Double(max(1, boxW * boxH))
      let diagRatio = Double(diag) / Double(count)
      let antiRatio = Double(anti) / Double(count)
      let score = min(diagRatio, antiRatio) - abs(density - 0.28) * 0.25
      if diagRatio >= 0.20 && antiRatio >= 0.20 && density >= 0.10 && density <= 0.58 && score >= 0.18 {
        candidates.append([
          "x": Double(displayBounds.minX) + Double(xStart + minX + boxW / 2) / scaleX,
          "y": Double(displayBounds.minY) + Double(yStart + minY + boxH / 2) / scaleY,
          "width": wPts,
          "height": hPts,
          "score": score
        ])
      }
    }
  }
  candidates.sort { a, b in
    let ax = a["x"] as? Double ?? 0
    let bx = b["x"] as? Double ?? 0
    return ax < bx
  }
  emit(candidates)
  exit(0)
}

// ---- 以下为「左侧栏裁剪截图」命令：scale 来自传入的逻辑区域宽高，而非整屏 ----
if cmd == "selected" {
  let regionWidth = argD(3)
  let regionHeight = argD(4)
  let targetY = argD(5)
  let rScaleY = Double(pxHeight) / max(regionHeight, 1)
  let centerY = Int((targetY * rScaleY).rounded())
  let yRadius = max(36, Int(rScaleY * 54.0))
  let yStart = max(0, centerY - yRadius)
  let yEnd = min(pxHeight - 1, centerY + yRadius)
  let xStart = min(pxWidth - 1, max(0, Int(Double(pxWidth) * 0.48)))
  let xEnd = pxWidth - 1
  var total = 0
  var green = 0
  if yStart <= yEnd && xStart <= xEnd {
    for y in yStart...yEnd {
      for x in xStart...xEnd {
        total += 1
        let (r, g, b, a) = RGBA(x, y)
        if a > 0.7 && g > 0.45 && g > r * 1.6 && g > b * 1.25 && r < 0.35 && b < 0.45 {
          green += 1
        }
      }
    }
  }
  let ratio = total > 0 ? Double(green) / Double(total) : 0
  emit(["ok": green >= 1200 && ratio >= 0.08, "green": green, "total": total, "ratio": ratio])
  exit(0)
}

if cmd == "already" {
  let regionWidth = argD(3)
  let regionHeight = argD(4)
  let rScaleY = Double(pxHeight) / max(regionHeight, 1)
  let yStart = min(pxHeight - 1, max(0, Int(rScaleY * 90.0)))
  var total = 0
  var black = 0
  var brightLower = 0
  var midLower = 0
  if yStart < pxHeight {
    for y in yStart..<pxHeight {
      for x in 0..<pxWidth {
        total += 1
        let (r, g, b, a) = RGBA(x, y)
        let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
        if a > 0.7 && luma < 0.05 { black += 1 }
        if y > Int(Double(pxHeight) * 0.62) && a > 0.7 {
          if luma > 0.78 { brightLower += 1 }
          if luma > 0.22 && luma < 0.72 { midLower += 1 }
        }
      }
    }
  }
  let blackRatio = total > 0 ? Double(black) / Double(total) : 0
  emit([
    "ok": blackRatio > 0.62 && brightLower > 450 && midLower > 280,
    "blackRatio": blackRatio,
    "brightLower": brightLower,
    "midLower": midLower
  ])
  exit(0)
}

if cmd == "leftrail" {
  let regionWidth = argD(3)
  let regionHeight = argD(4)
  let rScaleX = Double(pxWidth) / max(regionWidth, 1)
  let rScaleY = Double(pxHeight) / max(regionHeight, 1)
  var xStart = max(0, Int(Double(pxWidth) * 0.02), Int(rScaleX * 6.0))
  var xEnd = min(pxWidth - 1, Int(Double(pxWidth) * 0.52), Int(rScaleX * 78.0))
  if xStart > xEnd {
    xStart = 0
    xEnd = max(0, pxWidth - 1)
  }
  let minDark = max(3, (xEnd - xStart) / 45)
  var rows: [(y: Int, count: Int, minX: Int, maxX: Int)] = []
  for y in 0..<pxHeight {
    var count = 0
    var minX = pxWidth
    var maxX = 0
    if xStart <= xEnd {
      for x in xStart...xEnd {
        let (r, g, b, a) = RGBA(x, y)
        let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
        let chroma = max(r, g, b) - min(r, g, b)
        if a > 0.5 && luma < 0.54 && chroma < 0.42 {
          count += 1
          minX = min(minX, x)
          maxX = max(maxX, x)
        }
      }
    }
    if count >= minDark {
      rows.append((y, count, minX, maxX))
    }
  }

  var clusters: [[String: Any]] = []
  let gap = max(3, Int(rScaleY * 4.0))
  var i = 0
  while i < rows.count {
    let segStart = rows[i].y
    var segEnd = rows[i].y
    var maxCount = rows[i].count
    var minX = rows[i].minX
    var maxX = rows[i].maxX
    i += 1
    while i < rows.count && rows[i].y - segEnd <= gap {
      segEnd = rows[i].y
      maxCount = max(maxCount, rows[i].count)
      minX = min(minX, rows[i].minX)
      maxX = max(maxX, rows[i].maxX)
      i += 1
    }
    let logicalHeight = Double(segEnd - segStart + 1) / rScaleY
    let logicalWidth = Double(maxX - minX + 1) / rScaleX
    let centerY = (Double(segStart + segEnd) / 2.0) / rScaleY
    let centerX = (Double(minX + maxX) / 2.0) / rScaleX
    if logicalHeight >= 14 && logicalHeight <= 82 && logicalWidth >= 14 && logicalWidth <= 86 {
      clusters.append([
        "centerX": centerX,
        "centerY": centerY,
        "width": logicalWidth,
        "height": logicalHeight,
        "maxDark": maxCount
      ])
    }
  }
  emit(["clusters": clusters])
  exit(0)
}

dieDefault()
`;

const CACHE_DIR = join(DATA_DIR, '.cache');
const SOURCE_HASH = createHash('sha1').update(HELPER_SOURCE).digest('hex').slice(0, 12);
const BIN_PATH = join(CACHE_DIR, `wechat-helper-${SOURCE_HASH}`);
const SRC_PATH = join(CACHE_DIR, `wechat-helper-${SOURCE_HASH}.swift`);

let prepared = null; // { mode: 'binary'|'interpreted', exec: (cmd,args,opts)=>Promise }

function writeSourceOnce() {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(SRC_PATH)) writeFileSync(SRC_PATH, HELPER_SOURCE);
}

// 第一次调用时：写出源码 → 用 swiftc -O 编译成缓存二进制（原子重命名，避免并发半成品）。
// 编译只发生一次（按源码 hash 命名，源码不变就复用旧二进制）。失败则回退解释执行。
async function prepareHelper(runner) {
  try {
    writeSourceOnce();
    if (!existsSync(BIN_PATH)) {
      const tmp = `${BIN_PATH}.${process.pid}.tmp`;
      await runner('swiftc', ['-O', '-o', tmp, SRC_PATH], { timeout: 90_000 });
      try {
        renameSync(tmp, BIN_PATH);
      } catch {
        // 并发下别的进程可能已重命名好，存在即视为成功
        if (!existsSync(BIN_PATH)) throw new Error('swiftc 输出重命名失败');
      }
    }
    return { mode: 'binary', bin: BIN_PATH };
  } catch (e) {
    log.warn(`[RPA] 微信视频号 Swift 助手编译失败，回退解释执行（会更慢）：${String(e?.stderr || e?.message || e).slice(0, 300)}`);
    return { mode: 'interpreted', bin: null };
  }
}

/**
 * 运行微信视频号 Swift 助手的某个子命令，返回 { stdout, stderr }。
 * 与旧版 `runner('swift', ['-e', script, ...])` 同形：调用方继续读 `.stdout`。
 * @param {string} cmd 子命令，如 'click' / 'creator-cards' / 'already'
 * @param {Array<string|number>} args 子命令参数（路径、窗口坐标等）
 */
export async function runWechatSwift(cmd, args = [], { runner = execFileAsync, timeout = 10_000 } = {}) {
  if (!prepared) prepared = prepareHelper(runner);
  const ready = await prepared;
  const cmdArgs = [cmd, ...args.map((a) => String(a))];
  if (ready.mode === 'binary') {
    return runner(ready.bin, cmdArgs, { timeout, maxBuffer: 1024 * 1024 });
  }
  // 回退：解释执行同一份源码（`swift file.swift <cmd> <args>`，argv 与二进制一致）。
  writeSourceOnce();
  return runner('swift', [SRC_PATH, ...cmdArgs], { timeout: Math.max(timeout, 30_000), maxBuffer: 1024 * 1024 });
}

// 仅供测试重置内部状态（强制下次重新走编译判定）。
export function __resetWechatSwiftForTest() {
  prepared = null;
}
