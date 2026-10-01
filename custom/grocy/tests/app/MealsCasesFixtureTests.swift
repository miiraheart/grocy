import Foundation
import Testing
@testable import GrocyV2

/// The web WP3 case files (grocy-server custom/grocy/tests/{recipe-diet,dashboard,timer}-cases.json, copied to
/// GrocyV2Tests/Fixtures/meals-web/): the app and the web pages must give the same diet verdicts, Cook with swaps
/// lines, Use soon order, Today meals, thaw list and step timers.
@MainActor
@Suite struct MealsCasesFixtureTests {
    static func json(_ name: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/meals-web/\(name)")
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(type, from: JSONSerialization.data(withJSONObject: try #require(value)))
    }

    static func text(_ value: Any?) -> String { value == nil || value is NSNull ? "nil" : "\(value!)" }

    static func action(_ action: RecipeSwapView.Line.Action) -> String {
        switch action {
        case .none: return "none"
        case .swapped: return "swapped"
        case .omitOrReduce: return "omit"
        case .removeThisLine: return "remove"
        }
    }

    @Test func recipeVerdictsAndSwapsMatchTheWeb() throws {
        let doc = try Self.json("recipe-diet-cases.json")
        #expect(doc["rulesVersion"] as? String == DietRules.version)
        for c in try #require(doc["cases"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            let lines = c["lines"] as? [String] ?? [], steps = c["steps"] as? [String] ?? []
            let document = RecipeDocument(freeLines: lines.map { .init(text: $0) },
                                          stepSections: steps.isEmpty ? [] : [.init(name: nil, steps: steps.map { .init(text: $0) })])
            let record = RecipeRecord(columns: ["id": .number(1), "name": .string(name), "base_servings": .number(c["servings"] as? Double ?? 1),
                                                "description": .string(document.html(language: .fr))],
                                      userfields: (c["override"] as? Bool) == true ? ["diet_override": "1"] : [:], positions: [], nestings: [])
            let report = RecipeDiet.evaluate(record, products: [:])
            let expect = try #require(c["expect"] as? [String: Any])
            #expect(report.verdict.rawValue == expect["verdict"] as? String, "\(name)")
            #expect(report.isHardBlocked == expect["hardBlocked"] as? Bool, "\(name)")
            #expect(report.summaryText == expect["summary"] as? String, "\(name)")
            #expect(report.boosts == expect["boosts"] as? [String], "\(name)")
            for language in [AppLanguage.en, .fr] {
                let view = RecipeSwapView.build(record, report: report, products: [:], language: language)
                let want = (expect["lines_\(language.rawValue)"] as? [[String: Any]] ?? []).map { "\(Self.text($0["key"]))|\(Self.text($0["action"]))|\(Self.text($0["text"]))" }
                #expect(view.lines.map { "\($0.lineKey)|\(Self.action($0.action))|\($0.text)" } == want, "\(name) \(language.rawValue)")
                #expect(view.steps == expect["steps_\(language.rawValue)"] as? [String], "\(name) \(language.rawValue)")
            }
        }
    }

    @Test func useSoonMatchesTheWeb() throws {
        let doc = try Self.json("dashboard-cases.json")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let today = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 1, hour: 12)))
        for c in try #require(doc["useSoon"] as? [[String: Any]]) {
            let volatile = try #require(c["volatile"] as? [String: Any])
            let items = UseSoon.items(expired: try Self.decode([StockItem].self, volatile["expired_products"]),
                                      overdue: try Self.decode([StockItem].self, volatile["overdue_products"]),
                                      dueSoon: try Self.decode([StockItem].self, volatile["due_products"]),
                                      stock: try Self.decode([StockItem].self, c["stock"]), today: today)
            let got = items.map { item -> String in
                let status: String
                switch item.status {
                case .expired: status = "expired"
                case .bestBeforePassed: status = "bestBeforePassed"
                case .today: status = "today"
                case .tomorrow: status = "tomorrow"
                case .soon: status = "soon"
                case .fresh: status = "fresh"
                case .noDate: status = "noDate"
                }
                return "\(item.id)|\(item.days.map(String.init) ?? "nil")|\(item.opened)|\(item.canOpen)|\(status)"
            }
            let want = (c["expect"] as? [[String: Any]] ?? []).map {
                "\(Self.text($0["productId"]))|\(Self.text($0["days"]))|\(($0["opened"] as? Bool) == true)|\(($0["canOpen"] as? Bool) == true)|\(Self.text($0["status"]))"
            }
            #expect(got == want, "\(c["name"] ?? "")")
        }
    }

    @Test func todayMealsAndThawMatchTheWeb() throws {
        let doc = try Self.json("dashboard-cases.json")
        func names(_ c: [String: Any]) -> [Int: String] {
            Dictionary(uniqueKeysWithValues: (c["names"] as? [String: String] ?? [:]).compactMap { key, value in Int(key).map { ($0, value) } })
        }
        for c in try #require(doc["meals"] as? [[String: Any]]) {
            let meals = TodayMeals.meals(rows: try Self.decode([MealPlanRow].self, c["rows"]), day: c["day"] as? String ?? "",
                                         sections: try Self.decode([MealPlanSection].self, c["sections"]),
                                         recipes: RecipesData(recipes: try Self.decode([Recipe].self, c["recipes"])), productNames: names(c))
            let want = (c["expect"] as? [[String: Any]] ?? []).map {
                "\(Self.text($0["name"]))|\(Self.text($0["section"]))|\(($0["isRecipe"] as? Bool) == true)|\(($0["done"] as? Bool) == true)"
            }
            #expect(meals.map { "\($0.name)|\($0.section ?? "nil")|\($0.isRecipe)|\($0.done)" } == want)
        }
        for c in try #require(doc["thaw"] as? [[String: Any]]) {
            var positions: [Int: [RecipePosition]] = [:]
            for (key, value) in c["positions"] as? [String: Any] ?? [:] { positions[Int(key) ?? 0] = try Self.decode([RecipePosition].self, value) }
            let thaw = TodayMeals.thaw(today: try Self.decode([MealPlanRow].self, c["today"]), tomorrow: try Self.decode([MealPlanRow].self, c["tomorrow"]),
                                       positions: positions, entries: try Self.decode([StockEntry].self, c["entries"]),
                                       freezerIds: Set(c["freezers"] as? [Int] ?? []),
                                       recipes: RecipesData(recipes: try Self.decode([Recipe].self, c["recipes"])), productNames: names(c))
            let want = (c["expect"] as? [[String: Any]] ?? []).map { "\(Self.text($0["name"]))|\(Self.text($0["meal"]))|\(($0["tomorrow"] as? Bool) == true)" }
            #expect(thaw.map { "\($0.name)|\($0.meal)|\($0.tomorrow)" } == want)
        }
    }

    @Test func stepTimersMatchTheWeb() throws {
        for c in try #require(try Self.json("timer-cases.json")["cases"] as? [[String: Any]]) {
            let text = c["text"] as? String ?? ""
            let got = TimerDetector.timers(in: text).map { "\(text[$0.range])|\($0.seconds)|\($0.maxSeconds.map(String.init) ?? "nil")" }
            let want = (c["expect"] as? [[String: Any]] ?? []).map { "\(Self.text($0["match"]))|\(Self.text($0["seconds"]))|\(Self.text($0["maxSeconds"]))" }
            #expect(got == want, "\(text)")
        }
    }
}
