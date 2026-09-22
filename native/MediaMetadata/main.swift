import AVFoundation
import CoreLocation
import Foundation
import ImageIO

// Swift helper 使用一进程一请求的 JSON stdin/stdout 协议，避免 Node 直接解析平台元数据。
enum Operation: String, Codable {
    case inspect
    case reverseGeocode
}

struct Request: Codable {
    let operation: Operation
    let paths: [String]?
    let points: [GeoPoint]?
}

struct GeoPoint: Codable {
    let key: String
    let latitude: Double
    let longitude: Double
}

struct RawMediaMetadata: Codable {
    // 返回拍摄时间、时区偏移、GPS 和 Live Photo 标识；不会返回媒体内容。
    let path: String
    let kind: String
    let capturedAt: String?
    let offsetMinutes: Int?
    let latitude: Double?
    let longitude: Double?
    let assetIdentifier: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case path, kind, capturedAt, offsetMinutes, latitude, longitude, assetIdentifier, error
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(path, forKey: .path)
        try container.encode(kind, forKey: .kind)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encode(offsetMinutes, forKey: .offsetMinutes)
        try container.encode(latitude, forKey: .latitude)
        try container.encode(longitude, forKey: .longitude)
        try container.encode(assetIdentifier, forKey: .assetIdentifier)
        try container.encode(error, forKey: .error)
    }
}

struct PlaceResult: Codable {
    let key: String
    let country: String?
    let city: String?
    let status: String

    enum CodingKeys: String, CodingKey { case key, country, city, status }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(key, forKey: .key)
        try container.encode(country, forKey: .country)
        try container.encode(city, forKey: .city)
        try container.encode(status, forKey: .status)
    }
}

struct Response<T: Codable>: Codable {
    let results: [T]
}

struct ErrorResponse: Codable {
    let error: String
}

func run() async -> Int32 {
    // 解码 Node 请求并分派到元数据读取或 CoreLocation 反向地理编码。
    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(Request.self, from: input)
        switch request.operation {
        case .inspect:
            let results = await inspect(paths: request.paths ?? [])
            try write(Response(results: results))
        case .reverseGeocode:
            let results = await reverseGeocode(points: request.points ?? [])
            try write(Response(results: results))
        }
        return 0
    } catch {
        try? write(ErrorResponse(error: "invalid request"))
        return 1
    }
}

exit(await run())

func write<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
}

func inspect(paths: [String]) async -> [RawMediaMetadata] {
    // 并发读取多个文件，但按请求顺序组装结果，便于 Node 对应原始路径。
    await withTaskGroup(of: RawMediaMetadata.self, returning: [RawMediaMetadata].self) { group in
        for path in paths {
            group.addTask { await inspect(path: path) }
        }
        var byPath: [String: RawMediaMetadata] = [:]
        for await result in group { byPath[result.path] = result }
        return paths.compactMap { byPath[$0] }
    }
}

func inspect(path: String) async -> RawMediaMetadata {
    guard !hasNonFileScheme(path) else { return unsupported(path) }
    let url = URL(fileURLWithPath: path)
    let extensionName = url.pathExtension.lowercased()
    if ["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "dng", "cr2", "nef", "arw", "raf"].contains(extensionName) {
        return inspectImage(path: path, url: url)
    }
    if ["mov", "mp4", "m4v"].contains(extensionName) {
        return await inspectVideo(path: path, url: url)
    }
    return unsupported(path)
}

func hasNonFileScheme(_ path: String) -> Bool {
    guard let url = URL(string: path), let scheme = url.scheme else { return false }
    return scheme.lowercased() != "file"
}

func unsupported(_ path: String) -> RawMediaMetadata {
    RawMediaMetadata(path: path, kind: "unsupported", capturedAt: nil, offsetMinutes: nil,
                     latitude: nil, longitude: nil, assetIdentifier: nil, error: nil)
}

func inspectImage(path: String, url: URL) -> RawMediaMetadata {
    // 从 EXIF/TIFF/GPS/Apple MakerNote 提取照片信息。
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
        return RawMediaMetadata(path: path, kind: "photo", capturedAt: nil, offsetMinutes: nil,
                                latitude: nil, longitude: nil, assetIdentifier: nil,
                                error: "unable to read image metadata")
    }
    let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    let rawDate = string(exif[kCGImagePropertyExifDateTimeOriginal]) ?? string(tiff[kCGImagePropertyTIFFDateTime])
    let rawOffset = string(exif["OffsetTimeOriginal" as CFString]) ?? string(exif["OffsetTime" as CFString])
    let date = normalizeExifDate(rawDate, offset: rawOffset)
    let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any] ?? [:]
    let coordinates = imageCoordinates(gps)
    let maker = properties[kCGImagePropertyMakerAppleDictionary] as? [AnyHashable: Any] ?? [:]
    let assetIdentifier = string(maker[17]) ?? string(maker["17"])
    return RawMediaMetadata(path: path, kind: "photo", capturedAt: date?.value, offsetMinutes: date?.offset,
                            latitude: coordinates?.latitude, longitude: coordinates?.longitude,
                            assetIdentifier: assetIdentifier, error: nil)
}

func inspectVideo(path: String, url: URL) async -> RawMediaMetadata {
    // 从 AVFoundation 元数据读取视频创建时间、位置和 QuickTime 标识。
    do {
        let asset = AVURLAsset(url: url)
        let metadata = try await asset.load(.metadata)
        let creation = metadata.first { $0.commonKey?.rawValue == "creationDate" }?.stringValue
        let location = metadata.first { $0.commonKey?.rawValue == "location" }?.stringValue
        let assetIdentifier = quickTimeContentIdentifier(metadata)
        let date = normalizeISODate(creation)
        let coordinates = parseISO6709(location)
        return RawMediaMetadata(path: path, kind: "video", capturedAt: date?.value, offsetMinutes: date?.offset,
                                latitude: coordinates?.latitude, longitude: coordinates?.longitude,
                                assetIdentifier: assetIdentifier, error: nil)
    } catch {
        return RawMediaMetadata(path: path, kind: "video", capturedAt: nil, offsetMinutes: nil,
                                latitude: nil, longitude: nil, assetIdentifier: nil,
                                error: "unable to read video metadata")
    }
}

func imageCoordinates(_ gps: [CFString: Any]) -> (latitude: Double, longitude: Double)? {
    guard var latitude = number(gps[kCGImagePropertyGPSLatitude]),
          var longitude = number(gps[kCGImagePropertyGPSLongitude]) else { return nil }
    if string(gps[kCGImagePropertyGPSLatitudeRef])?.uppercased() == "S" { latitude = -latitude }
    if string(gps[kCGImagePropertyGPSLongitudeRef])?.uppercased() == "W" { longitude = -longitude }
    guard (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
    return (latitude, longitude)
}

func normalizeExifDate(_ rawDate: String?, offset: String?) -> (value: String, offset: Int?)? {
    guard let rawDate else { return nil }
    let minutes = offset.flatMap(offsetMinutes)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
    formatter.timeZone = TimeZone(secondsFromGMT: (minutes ?? 0) * 60)
    guard let date = formatter.date(from: rawDate) else { return nil }
    return (formatISO8601(date, minutes), minutes)
}

func normalizeISODate(_ rawDate: String?) -> (value: String, offset: Int?)? {
    guard let rawDate else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: rawDate) ?? {
        let fallback = ISO8601DateFormatter()
        fallback.formatOptions = [.withInternetDateTime]
        return fallback.date(from: rawDate)
    }()
    guard let date else { return nil }
    let minutes = isoOffsetMinutes(rawDate)
    return (formatISO8601(date, minutes), minutes)
}

func formatISO8601(_ date: Date, _ offset: Int?) -> String {
    guard let offset else {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.string(from: date)
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: offset * 60)
    return formatter.string(from: date)
}

func offsetMinutes(_ offset: String) -> Int? {
    if offset == "Z" { return 0 }
    let expression = try? NSRegularExpression(pattern: "^([+-])(\\d{2}):?(\\d{2})$")
    let range = NSRange(offset.startIndex..., in: offset)
    guard let match = expression?.firstMatch(in: offset, range: range),
          let signRange = Range(match.range(at: 1), in: offset),
          let hourRange = Range(match.range(at: 2), in: offset),
          let minuteRange = Range(match.range(at: 3), in: offset),
          let hour = Int(offset[hourRange]), let minute = Int(offset[minuteRange]), hour <= 23, minute <= 59 else { return nil }
    let total = hour * 60 + minute
    return offset[signRange] == "-" ? -total : total
}

func isoOffsetMinutes(_ value: String) -> Int? {
    if value.hasSuffix("Z") { return 0 }
    let expression = try? NSRegularExpression(pattern: "([+-]\\d{2}:?\\d{2})$")
    let range = NSRange(value.startIndex..., in: value)
    guard let match = expression?.firstMatch(in: value, range: range), let matchRange = Range(match.range, in: value) else { return nil }
    return offsetMinutes(String(value[matchRange]))
}

func parseISO6709(_ value: String?) -> (latitude: Double, longitude: Double)? {
    guard let value else { return nil }
    let expression = try? NSRegularExpression(pattern: "^([+-]\\d+(?:\\.\\d+)?)([+-]\\d+(?:\\.\\d+)?)(?:[+-]\\d+(?:\\.\\d+)?)?/?$")
    let range = NSRange(value.startIndex..., in: value)
    guard let match = expression?.firstMatch(in: value, range: range),
          let latitudeRange = Range(match.range(at: 1), in: value),
          let longitudeRange = Range(match.range(at: 2), in: value),
          let latitude = Double(value[latitudeRange]), let longitude = Double(value[longitudeRange]),
          (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
    return (latitude, longitude)
}

func string(_ value: Any?) -> String? {
    if let value = value as? String, !value.isEmpty { return value }
    if let value = value as? NSString, value.length > 0 { return value as String }
    return nil
}

func number(_ value: Any?) -> Double? {
    if let value = value as? NSNumber { return value.doubleValue }
    if let value = value as? String { return Double(value) }
    return nil
}

func reverseGeocode(points: [GeoPoint]) async -> [PlaceResult] {
    var results: [PlaceResult] = []
    for point in points {
        guard (-90...90).contains(point.latitude), (-180...180).contains(point.longitude) else {
            results.append(PlaceResult(key: point.key, country: nil, city: nil, status: "unresolved"))
            continue
        }
        do {
            let location = CLLocation(latitude: point.latitude, longitude: point.longitude)
            let geocoder = CLGeocoder()
            let placemarks = try await geocoder.reverseGeocodeLocation(location, preferredLocale: Locale(identifier: "zh_CN"))
            guard let placemark = placemarks.first,
                  let country = placemark.country, !country.isEmpty,
                  let city = (placemark.locality ?? placemark.administrativeArea), !city.isEmpty else {
                results.append(PlaceResult(key: point.key, country: nil, city: nil, status: "unresolved"))
                continue
            }
            results.append(PlaceResult(key: point.key, country: country, city: city, status: "resolved"))
        } catch {
            results.append(PlaceResult(key: point.key, country: nil, city: nil, status: "unresolved"))
        }
    }
    return results
}
