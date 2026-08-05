import AppKit
import Foundation

struct ClipboardEntry: Codable {
    let type: String
    let data: Data
}

struct ClipboardItemSnapshot: Codable {
    let entries: [ClipboardEntry]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: clipboard-state <save|restore> <snapshot.json>")
}

let operation = CommandLine.arguments[1]
let snapshotURL = URL(fileURLWithPath: CommandLine.arguments[2])
let pasteboard = NSPasteboard.general

switch operation {
case "save":
    let snapshots = (pasteboard.pasteboardItems ?? []).map { item in
        ClipboardItemSnapshot(entries: item.types.compactMap { type in
            guard let data = item.data(forType: type) else { return nil }
            return ClipboardEntry(type: type.rawValue, data: data)
        })
    }
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(snapshots).write(to: snapshotURL, options: .atomic)
    } catch {
        fail("Failed to save clipboard: \(error)")
    }
case "restore":
    do {
        let snapshots = try JSONDecoder().decode([ClipboardItemSnapshot].self, from: Data(contentsOf: snapshotURL))
        let items = snapshots.map { snapshot -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for entry in snapshot.entries {
                item.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type))
            }
            return item
        }
        pasteboard.clearContents()
        if !items.isEmpty && !pasteboard.writeObjects(items) {
            fail("Failed to restore clipboard objects")
        }
    } catch {
        fail("Failed to restore clipboard: \(error)")
    }
default:
    fail("Unknown operation: \(operation)")
}
