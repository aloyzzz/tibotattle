// The menu bar popover: allowance meters, period totals, top models and the
// app's actions. Missing values render as "—" or "unpriced", never as 0.

import SwiftUI
import TiboTattleCore

struct PopoverView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage(Prefs.periodKey) private var periodRaw: String = Prefs.defaultPeriod

    private static let periodLabels: [String: String] = ["24h": "24h", "7d": "7d", "30d": "30d", "all": "All"]
    private static let periodText: [String: String] = [
        "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "all": "all recorded time",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let message = model.fatalMessage {
                Text(message)
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Picker("Period", selection: $periodRaw) {
                    ForEach(Period.allCases, id: \.self) { period in
                        Text(Self.periodLabels[period.rawValue] ?? period.rawValue).tag(period.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                TimelineView(.everyMinute) { context in
                    summary(now: context.date)
                }
            }
            Divider()
            actions
        }
        .padding(14)
        .frame(width: 340)
        .onAppear {
            model.reloadSummaries()
            model.updateLoginItemState()
        }
        .onChange(of: periodRaw) { _ in
            model.reloadSummaries()
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text("TiboTattle").font(.headline)
                Spacer(minLength: 8)
                Text(refreshText)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            ForEach(warnings, id: \.self) { warning in
                Text(warning)
                    .font(.caption)
                    .foregroundColor(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var refreshText: String {
        if model.isRefreshing { return "Refreshing…" }
        if !model.isReady { return model.fatalMessage == nil ? "Starting…" : "" }
        if let at = model.status?.lastRefreshAt { return "Updated \(Format.ago(at, now: Date()))" }
        return ""
    }

    /// Mirrors the warnings in `renderStatus` (apps/web/app.js).
    private var warnings: [String] {
        guard let st = model.status else { return [] }
        var out: [String] = []
        let roots = st.sources?.sessionRoots ?? []
        if !roots.isEmpty && roots.allSatisfy({ $0.status != "readable" }) {
            out.append("omp session folder not found")
        }
        switch st.sources?.agentDb {
        case "missing": out.append("omp agent.db not found, so no allowance data")
        case "unavailable": out.append("omp agent.db could not be read")
        default: break
        }
        if let code = model.lastRefreshError ?? st.lastError {
            out.append("Last refresh failed (\(Loader.sanitizedCode(code)))")
        }
        return out
    }

    // MARK: Summary

    @ViewBuilder
    private func summary(now: Date) -> some View {
        if let overview = model.overview {
            VStack(alignment: .leading, spacing: 14) {
                allowanceSection(overview.allowance ?? [], now: now)
                totalsSection(overview.totals)
                modelsSection(overview.topModels ?? [])
            }
        } else if let code = model.overviewError {
            Text("Couldn't load the summary (\(code)).")
                .font(.callout)
                .foregroundColor(.secondary)
        } else {
            Text("Loading…")
                .font(.callout)
                .foregroundColor(.secondary)
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundColor(.secondary)
            .textCase(.uppercase)
    }

    @ViewBuilder
    private func allowanceSection(_ series: [AllowanceDTO], now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Allowance")
            if series.isEmpty {
                Text("No subscription usage recorded by omp yet.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            } else if series.count > 4 {
                ScrollView {
                    allowanceRows(series, now: now)
                }
                .frame(maxHeight: 280)
            } else {
                allowanceRows(series, now: now)
            }
        }
    }

    private func allowanceRows(_ series: [AllowanceDTO], now: Date) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(series.enumerated()), id: \.offset) { _, item in
                AllowanceRow(series: item, now: now)
            }
        }
    }

    @ViewBuilder
    private func totalsSection(_ totals: TotalsDTO?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Totals · \(Self.periodText[periodRaw] ?? "this period")")
            if let t = totals, let requests = t.requests, requests > 0 {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        StatCell(label: "Requests", value: Format.int(t.requests), note: errorNote(t))
                        StatCell(label: "Tokens", value: Format.compact(t.totalTokens), note: tokenNote(t))
                    }
                    GridRow {
                        let cost = Format.cost(t)
                        StatCell(label: "Cost", value: cost, note: Format.unpricedNote(t), muted: cost == "unpriced")
                        StatCell(label: "Cache hit rate", value: Format.pct(t.cacheHitRate), note: nil,
                                 muted: t.cacheHitRate == nil)
                    }
                }
            } else {
                Text("No omp requests in \(Self.periodText[periodRaw] ?? "this period").")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
        }
    }

    private func errorNote(_ t: TotalsDTO) -> String? {
        guard let errors = t.errorRequests, errors > 0 else { return nil }
        return "\(Format.int(errors)) ended in error"
    }

    private func tokenNote(_ t: TotalsDTO) -> String? {
        var parts: [String] = []
        if t.input != nil || t.output != nil {
            parts.append("\(Format.compact(t.input)) in · \(Format.compact(t.output)) out")
        }
        if let unknown = t.unknownTokenRequests, unknown > 0 {
            parts.append("+\(Format.int(unknown)) uncounted")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func modelsSection(_ models: [ModelDTO]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                sectionTitle("Top models")
                Spacer()
                Text("tok/s").font(.caption).foregroundColor(.secondary).frame(width: 52, alignment: .trailing)
                Text("TTFT").font(.caption).foregroundColor(.secondary).frame(width: 62, alignment: .trailing)
            }
            if models.isEmpty {
                Text("No timed requests in this period.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            } else {
                ForEach(Array(models.prefix(5).enumerated()), id: \.offset) { _, m in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.model ?? Format.dash)
                                .font(.callout)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(m.provider ?? "")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        Text(Format.tps(m.decodeTps?.median))
                            .font(.callout)
                            .monospacedDigit()
                            .frame(width: 52, alignment: .trailing)
                        Text(Format.ms(m.ttftMs?.median))
                            .font(.callout)
                            .monospacedDigit()
                            .frame(width: 62, alignment: .trailing)
                    }
                    .help("Median decode speed and time to first token")
                }
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button("Open Dashboard") { model.openDashboard() }
                    .disabled(!model.isReady)
                Button("Refresh") { model.refresh() }
                    .disabled(!model.isReady || model.isRefreshing)
                Spacer()
                Button("Quit") { model.quit() }
                    .keyboardShortcut("q")
            }
            Toggle("Start at login", isOn: Binding(
                get: { model.loginItemEnabled },
                set: { model.setLoginItem($0) }
            ))
            .toggleStyle(.checkbox)
            if let note = model.loginItemNote {
                Text(note)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Pieces

private struct StatCell: View {
    let label: String
    let value: String
    let note: String?
    var muted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption).foregroundColor(.secondary)
            Text(value)
                .font(.headline)
                .monospacedDigit()
                .foregroundColor(muted ? .secondary : .primary)
                .lineLimit(1)
            if let note = note {
                Text(note).font(.caption2).foregroundColor(.secondary).lineLimit(1)
            }
        }
        .frame(minWidth: 130, alignment: .leading)
    }
}

private struct AllowanceRow: View {
    let series: AllowanceDTO
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(series.title)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    Text(series.accountLabel ?? series.provider ?? "")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if series.isStale {
                    Text("Stale")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.2)))
                        .foregroundColor(.orange)
                }
                Text(series.remainingFraction.map { Format.pct($0, digits: 0) } ?? Format.dash)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(series.remainingFraction == nil ? .secondary : .primary)
            }
            MeterBar(fraction: series.remainingFraction, tone: series.tone, label: series.title)
            HStack(spacing: 6) {
                Text(Format.countdown(to: series.resetsAt, now: now))
                if series.isStale {
                    Text("· last reading \(Format.ago(series.recordedAt, now: now))")
                }
            }
            .font(.caption)
            .foregroundColor(.secondary)
            .lineLimit(1)
            if let pace = series.paceLine(now: now) {
                Text(pace.text)
                    .font(.caption)
                    .foregroundColor(pace.warn ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct MeterBar: View {
    let fraction: Double?
    let tone: AllowanceDTO.Tone
    let label: String

    private var color: Color {
        switch tone {
        case .ok: return .accentColor
        case .warn: return .orange
        case .critical: return .red
        case .unknown: return .secondary
        }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1))
                if let f = fraction {
                    Capsule()
                        .fill(color)
                        .frame(width: CGFloat(max(0, min(1, f))) * geo.size.width)
                }
            }
        }
        .frame(height: 6)
        .accessibilityElement()
        .accessibilityLabel("\(label) remaining")
        .accessibilityValue(fraction.map { "\(Format.pct($0, digits: 0)) remaining" } ?? "No reading")
    }
}
