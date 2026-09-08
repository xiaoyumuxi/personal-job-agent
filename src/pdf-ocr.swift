import Foundation
import CoreGraphics
import Vision

// Controlled file/page requests arrive on stdin; recognized text only returns
// on stdout to the caller. No images or OCR text are written to temporary files.
struct Input: Decodable { let file: String; let pages: [Int] }
struct PageText: Encodable { let page: Int; let text: String }
struct Output: Encodable { let pages: [PageText] }
enum OCRFailure: Error { case invalidInput, invalidPDF, pageLimit, renderFailed }

@available(macOS 11.0, *)
func recognize(_ input: Input) throws -> Output {
    guard input.file.hasPrefix("/"), !input.pages.isEmpty,
          Set(input.pages).count == input.pages.count,
          input.pages.allSatisfy({ $0 > 0 }) else { throw OCRFailure.invalidInput }
    guard input.pages.count <= 20 else { throw OCRFailure.pageLimit }
    let url = URL(fileURLWithPath: input.file)
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0, size <= 20 * 1024 * 1024,
          let document = CGPDFDocument(url as CFURL), !document.isEncrypted else {
        throw OCRFailure.invalidPDF
    }
    var result: [PageText] = []
    for number in input.pages {
        let item = try autoreleasepool { () throws -> PageText in
            guard let page = document.page(at: number) else { throw OCRFailure.invalidPDF }
            let bounds = page.getBoxRect(.cropBox)
            guard bounds.width.isFinite, bounds.height.isFinite,
                  bounds.width > 0, bounds.height > 0 else { throw OCRFailure.renderFailed }
            let scale = min(3.0, 2600 / max(bounds.width, bounds.height))
            let width = max(1, Int(ceil(bounds.width * scale)))
            let height = max(1, Int(ceil(bounds.height * scale)))
            guard let context = CGContext(data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw OCRFailure.renderFailed }
            let target = CGRect(x: 0, y: 0, width: width, height: height)
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(target)
            context.concatenate(page.getDrawingTransform(.cropBox, rect: target, rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
            guard let image = context.makeImage() else { throw OCRFailure.renderFailed }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            let supported = try request.supportedRecognitionLanguages()
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
            if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            // Preserve line boundaries for the existing label-based parser.
            let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            let text = lines.joined(separator: "\n")
            guard text.count <= 12000 else { throw OCRFailure.pageLimit }
            return PageText(page: number, text: text)
        }
        result.append(item)
    }
    return Output(pages: result)
}

do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 65536 else { throw OCRFailure.invalidInput }
    let input = try JSONDecoder().decode(Input.self, from: data)
    if #available(macOS 11.0, *) {
        let output = try recognize(input)
        FileHandle.standardOutput.write(try JSONEncoder().encode(output))
    } else {
        FileHandle.standardOutput.write(Data("{\"error\":\"unsupported_macos\"}".utf8))
        exit(2)
    }
} catch {
    // Do not echo paths, PDF content, framework diagnostics or personal text.
    FileHandle.standardOutput.write(Data("{\"error\":\"ocr_failed\"}".utf8))
    exit(1)
}
