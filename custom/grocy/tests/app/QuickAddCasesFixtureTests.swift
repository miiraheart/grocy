import Foundation
import Testing
@testable import GrocyV2

/// The quick add cases shared with the web (grocy-server custom/grocy/tests/quickadd-cases.json, copied to
/// GrocyV2Tests/Fixtures/chores-p18/quickadd-cases.json): the app and the web page must parse every line alike.
@Suite struct QuickAddCasesFixtureTests {
    struct Doc: Decodable {
        let now: String
        let cases: [Case]
    }

    struct Case: Decodable, CustomTestStringConvertible, Sendable {
        let text: String
        let categories: [String]?
        let expect: [String: Value]
        var testDescription: String { text }
    }

    enum Value: Decodable, Sendable, Equatable {
        case null, bool(Bool), int(Int), text(String), list([String]), schedule(Schedule)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null }
            else if let v = try? c.decode(Bool.self) { self = .bool(v) }
            else if let v = try? c.decode(Int.self) { self = .int(v) }
            else if let v = try? c.decode(String.self) { self = .text(v) }
            else if let v = try? c.decode([String].self) { self = .list(v) }
            else { self = .schedule(try c.decode(Schedule.self)) }
        }

        var text: String? { if case .text(let v) = self { v } else { nil } }
    }

    struct Schedule: Decodable, Sendable, Equatable {
        let period: String
        let interval: Int
        let weekdays: [String]
        let dayOfMonth: Int
        let startDate: String?

        var value: ChoreSchedule? {
            guard let period = ChoreSchedule.Period(rawValue: period) else { return nil }
            return ChoreSchedule(period: period, interval: interval, weekdays: weekdays.compactMap(ChoreSchedule.Weekday.init(rawValue:)),
                                 dayOfMonth: dayOfMonth, startDate: startDate)
        }
    }

    static let doc: Doc = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/chores-p18/quickadd-cases.json")
        guard let data = try? Data(contentsOf: url), let doc = try? JSONDecoder().decode(Doc.self, from: data) else {
            return Doc(now: "", cases: [])
        }
        return doc
    }()

    static var now: Date {
        let parts = doc.now.split(whereSeparator: { "- :".contains($0) }).compactMap { Int($0) }
        return AgendaClock.paris.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3],
                                                           minute: parts[4], second: parts[5])) ?? .now
    }

    @Test func theCaseFileIsThere() {
        #expect(Self.doc.cases.count >= 60)
    }

    @Test(arguments: doc.cases) func parsesLikeTheWeb(_ item: Case) {
        let r = QuickAddParser.parse(item.text, categories: item.categories ?? [], now: Self.now)
        for (key, want) in item.expect {
            switch key {
            case "name": #expect(r.name == want.text)
            case "day": #expect(r.dueDay == want.text)
            case "time": #expect(r.time == want.text)
            case "room": #expect(r.room?.rawValue == want.text)
            case "category": #expect(r.category == want.text)
            case "newCategory": #expect(want == .bool(r.newCategory))
            case "priority": #expect(r.priority?.rawValue == want.text)
            case "effort": #expect(r.effort.map(Value.int) ?? .null == want)
            case "handOff": #expect(want == .bool(r.handOff))
            case "warnings": #expect(want == .list(r.warnings.map { _ in "priorityOnChore" }))
            case "schedule":
                if case .schedule(let s) = want { #expect(r.schedule == s.value) } else { #expect(r.schedule == nil) }
            default: Issue.record("unknown key \(key)")
            }
        }
    }
}
