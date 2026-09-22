import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Synthetic 32x32 pixels only. The generator never reads user media or uses networking.
struct ExpectedMetadata: Codable {
    let kind: String
    var capturedAt: String? = nil
    var offsetMinutes: Int? = nil
    var latitude: Double? = nil
    var longitude: Double? = nil
    var assetIdentifier: String? = nil

    enum CodingKeys: String, CodingKey { case kind, capturedAt, offsetMinutes, latitude, longitude, assetIdentifier }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encode(capturedAt, forKey: .capturedAt)
        try values.encode(offsetMinutes, forKey: .offsetMinutes)
        try values.encode(latitude, forKey: .latitude)
        try values.encode(longitude, forKey: .longitude)
        try values.encode(assetIdentifier, forKey: .assetIdentifier)
    }
}

struct Fixture: Codable {
    let name: String
    let path: String
    let sha256: String
    let metadata: ExpectedMetadata
}
struct Manifest: Codable { let version = 1; let files: [Fixture] }

enum FixtureError: Error { case generation(String) }

@main
struct CreateMediaFixtures {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw FixtureError.generation("Expected output directory") }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let dated = ExpectedMetadata(kind: "photo", capturedAt: "2026-09-21T14:30:00+08:00",
                                     offsetMinutes: 480, latitude: 31.2304, longitude: 121.4737)
        let live = ExpectedMetadata(kind: "photo", capturedAt: "2026-09-21T14:30:00+08:00",
                                    offsetMinutes: 480, assetIdentifier: "test-live-photo-1")
        let motion = ExpectedMetadata(kind: "video", capturedAt: "2026-09-21T14:30:00+08:00",
                                      offsetMinutes: 480, assetIdentifier: "test-live-photo-1")
        let video = ExpectedMetadata(kind: "video", capturedAt: "2026-09-21T14:30:00+08:00", offsetMinutes: 480)
        let specifications: [(String, ExpectedMetadata)] = [
            ("dated.jpg", dated), ("live.HEIC", live), ("live.MOV", motion),
            ("video.MOV", video), ("undated.png", ExpectedMetadata(kind: "photo"))
        ]
        for (name, metadata) in specifications {
            let url = root.appendingPathComponent(name)
            if metadata.kind == "video" { try await makeVideo(url, metadata) }
            else { try makeImage(url, metadata) }
        }
        let files = try specifications.map { name, metadata in
            let url = root.appendingPathComponent(name)
            let hash = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
            return Fixture(name: name, path: url.path, sha256: hash, metadata: metadata)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        FileHandle.standardOutput.write(try encoder.encode(Manifest(files: files)))
    }

    static func makeImage(_ url: URL, _ expected: ExpectedMetadata) throws {
        guard let context = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw FixtureError.generation("Cannot create synthetic image context")
        }
        context.setFillColor(CGColor(red: 0.25, green: 0.5, blue: 0.75, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        guard let image = context.makeImage() else { throw FixtureError.generation("Cannot create synthetic image") }
        let type: UTType = url.pathExtension.lowercased() == "heic" ? .heic : url.pathExtension == "png" ? .png : .jpeg
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
            throw FixtureError.generation("ImageIO cannot encode \(type.identifier)")
        }
        var properties: [CFString: Any] = [:]
        if expected.capturedAt != nil {
            properties[kCGImagePropertyExifDictionary] = [kCGImagePropertyExifDateTimeOriginal: "2026:09:21 14:30:00",
                                                          "OffsetTimeOriginal" as CFString: "+08:00"]
        }
        if let latitude = expected.latitude, let longitude = expected.longitude {
            properties[kCGImagePropertyGPSDictionary] = [kCGImagePropertyGPSLatitude: latitude,
                                                         kCGImagePropertyGPSLatitudeRef: "N",
                                                         kCGImagePropertyGPSLongitude: longitude,
                                                         kCGImagePropertyGPSLongitudeRef: "E"]
        }
        if let identifier = expected.assetIdentifier {
            properties[kCGImagePropertyMakerAppleDictionary] = ["17": identifier]
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw FixtureError.generation("ImageIO failed to write \(url.lastPathComponent)") }
        if let identifier = expected.assetIdentifier {
            // ImageIO pads its fixed-width Apple MakerNote UUID field with periods.
            // Correct the ASCII field count for this short synthetic ID and NUL-fill
            // the spare bytes, preserving the HEIC size and every EXIF data offset.
            var data = try Data(contentsOf: url)
            let marker = Data(identifier.utf8)
            let headerBytes = Data([0x41, 0x70, 0x70, 0x6c, 0x65, 0x20, 0x69, 0x4f, 0x53, 0, 0, 1, 0x4d, 0x4d,
                                    0, 1, 0, 0x11, 0, 2, 0, 0, 0, 0x25, 0, 0, 0, 0x20, 0, 0, 0, 0])
            guard let header = data.range(of: headerBytes), let range = data.range(of: marker),
                  range.lowerBound == header.upperBound, marker.count < 36,
                  data.range(of: marker, in: range.upperBound..<data.count) == nil else {
                throw FixtureError.generation("Unexpected synthetic MakerNote layout; review ImageIO writer changes")
            }
            var end = range.upperBound
            while end < data.count && data[end] == 0x2e { data[end] = 0; end += 1 }
            data[header.lowerBound + 23] = UInt8(marker.count + 1)
            try data.write(to: url)
        }
    }

    static func item(_ identifier: AVMetadataIdentifier, _ value: String) -> AVMetadataItem {
        let item = AVMutableMetadataItem()
        item.identifier = identifier
        item.value = value as NSString
        item.dataType = kCMMetadataBaseDataType_UTF8 as String
        return item
    }

    static func makeVideo(_ url: URL, _ expected: ExpectedMetadata) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        var metadata = [item(.quickTimeMetadataCreationDate, expected.capturedAt!)]
        if let identifier = expected.assetIdentifier { metadata.append(item(.quickTimeMetadataContentIdentifier, identifier)) }
        writer.metadata = metadata
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.jpeg, AVVideoWidthKey: 32, AVVideoHeightKey: 32
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
            sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                                          kCVPixelBufferWidthKey as String: 32, kCVPixelBufferHeightKey as String: 32])
        guard writer.canAdd(input) else { throw FixtureError.generation("Cannot add synthetic video input") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? FixtureError.generation("Cannot start video writer") }
        writer.startSession(atSourceTime: .zero)
        var pixelBuffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 32, 32, kCVPixelFormatType_32ARGB, nil, &pixelBuffer) == kCVReturnSuccess,
              let pixelBuffer else { throw FixtureError.generation("Cannot create synthetic video pixels") }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let bytes = CVPixelBufferGetBaseAddress(pixelBuffer) { memset(bytes, 128, CVPixelBufferGetDataSize(pixelBuffer)) }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        let deadline = Date().addingTimeInterval(10)
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing, Date() < deadline else { throw writer.error ?? FixtureError.generation("Video input readiness timeout") }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        guard adaptor.append(pixelBuffer, withPresentationTime: .zero) else { throw writer.error ?? FixtureError.generation("Cannot append synthetic frame") }
        writer.endSession(atSourceTime: CMTime(value: 1, timescale: 10))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? FixtureError.generation("Cannot finish video") }
    }
}
