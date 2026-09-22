import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
let image = context.makeImage()!
for (name, date) in [
    ("month-end.jpg", "2026:09:30 16:30:00"), ("year-end.jpg", "2026:12:31 23:30:00"),
    ("month-start.jpg", "2026:10:01 00:30:00"), ("year-start.jpg", "2026:01:01 00:30:00")
] {
    let destination = CGImageDestinationCreateWithURL(root.appendingPathComponent(name) as CFURL,
                                                      UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyExifDictionary: [
        kCGImagePropertyExifDateTimeOriginal: date
    ]] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fatalError("JPEG fixture generation failed") }
}
