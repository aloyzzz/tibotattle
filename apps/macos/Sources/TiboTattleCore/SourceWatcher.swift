// FSEvents watcher for the omp session roots and the agent.db directory.
// Best-effort: paths that do not exist are skipped; callers keep a fallback
// timer. The callback only signals "something changed"; it carries no paths.

#if canImport(CoreServices)
import CoreServices
import Foundation

public final class SourceWatcher {
    private let paths: [String]
    private let latency: TimeInterval
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "tibotattle.source-watcher", qos: .utility)
    private var stream: FSEventStreamRef?

    public init(paths: [URL], latency: TimeInterval = 1.0, onChange: @escaping @Sendable () -> Void) {
        self.paths = PathUtil.unique(paths.map { PathUtil.resolve($0.path) })
        self.latency = latency
        self.onChange = onChange
    }

    deinit {
        stop()
    }

    fileprivate func fire() {
        onChange()
    }

    /// Starts the stream on existing paths. Calling start twice is a no-op.
    public func start() {
        guard stream == nil else { return }
        let existing = paths.filter { FileManager.default.fileExists(atPath: $0) }
        guard !existing.isEmpty else { return }

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info = info else { return }
            let watcher = Unmanaged<SourceWatcher>.fromOpaque(info).takeUnretainedValue()
            watcher.fire()
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            existing as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            latency,
            flags
        ) else { return }
        FSEventStreamSetDispatchQueue(created, queue)
        if !FSEventStreamStart(created) {
            FSEventStreamInvalidate(created)
            FSEventStreamRelease(created)
            return
        }
        stream = created
    }

    public func stop() {
        guard let s = stream else { return }
        stream = nil
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
    }
}
#endif
