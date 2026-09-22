import AVFoundation

// Live Photo 的照片和视频共享 QuickTime content identifier，用于安全成组移动。
func quickTimeContentIdentifier(_ metadata: [AVMetadataItem]) -> String? {
    metadata.first { $0.identifier == .quickTimeMetadataContentIdentifier }?.stringValue
}
