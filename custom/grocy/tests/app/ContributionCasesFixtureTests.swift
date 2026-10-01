import Foundation
import Testing
@testable import GrocyV2

/// The web WP4 merge case file (grocy-server custom/grocy/tests/contribution-cases.json, copied to
/// GrocyV2Tests/Fixtures/shopping-web/): the web GC.shop.merge and ContributionMerge, ContributionCaption and
/// RecipeShareSync must decide, caption and remove shares the same way.
@MainActor
@Suite struct ContributionCasesFixtureTests {
    static func json(_ name: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/shopping-web/\(name)")
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    static func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

    static func unit(_ value: Any?) -> UnitRef? {
        guard let dict = value as? [String: Any] else { return nil }
        if let key = dict["kitchen"] as? String { return .kitchen(key) }
        guard let grocy = dict["grocy"] as? [String: Any], let id = grocy["id"] as? Int, let name = grocy["name"] as? String else { return nil }
        return .grocy(QuantityUnit(id: id, name: name, description: nil, namePlural: nil, pluralForms: nil, rowCreatedTimestamp: nil))
    }

    static func share(_ value: Any) -> RecipeShare? {
        guard let dict = value as? [String: Any], let recipe = dict["recipe"] as? Int else { return nil }
        return RecipeShare(recipe: recipe, mealPlan: dict["mealPlan"] as? Int, day: dict["day"] as? String,
                           amount: number(dict["amount"]) ?? 0, qu: dict["qu"] as? Int, servings: number(dict["servings"]))
    }

    static func shares(_ value: Any?) -> [RecipeShare] { (value as? [Any] ?? []).compactMap(Self.share) }

    static func row(_ value: Any?) -> ContributionRow? {
        guard let dict = value as? [String: Any], let id = dict["id"] as? Int else { return nil }
        return ContributionRow(id: id, amount: number(dict["amount"]) ?? 0, unit: unit(dict["unit"]), qtyText: dict["qtyText"] as? String,
                               done: dict["done"] as? Bool ?? false, shares: shares(dict["shares"]),
                               inboxIds: Set(dict["inboxIds"] as? [String] ?? []))
    }

    static func incoming(_ dict: [String: Any]) -> ContributionIncoming {
        let source = dict["source"] as? [String: Any] ?? [:]
        let kind: ContributionSource
        switch source["kind"] as? String {
        case "inbox": kind = .inbox(source["id"] as? String ?? "")
        case "recipe": kind = source["share"].flatMap(Self.share).map(ContributionSource.recipe) ?? .manual
        default: kind = .manual
        }
        return ContributionIncoming(source: kind, amount: number(dict["amount"]) ?? 0, unit: unit(dict["unit"]), qtyText: dict["qtyText"] as? String,
                                    productId: dict["productId"] as? Int, productName: dict["productName"] as? String)
    }

    static func decision(_ dict: [String: Any]) -> ContributionMerge.Decision? {
        let id = dict["rowId"] as? Int ?? 0
        let value = { (key: String) in Self.number(dict[key]) ?? 0 }
        switch dict["kind"] as? String {
        case "create": return .create
        case "noChange": return .noChange(rowId: id)
        case "replaceShare": return .replaceShare(rowId: id, amount: value("amount"), shares: Self.shares(dict["shares"]))
        case "reopen": return .reopen(rowId: id, amount: value("amount"), shares: Self.shares(dict["shares"]))
        case "confirm": return .confirm(rowId: id, current: value("current"), incoming: value("incoming"), sum: value("sum"))
        case "confirmUnconvertible": return .confirmUnconvertible(rowId: id, current: value("current"), incoming: dict["incoming"] as? String ?? "")
        default: return nil
        }
    }

    static func choice(_ dict: [String: Any]) -> ContributionChoice {
        switch dict["kind"] as? String {
        case "add": return .add
        case "set": return .set(number(dict["amount"]) ?? 0, note: dict["note"] as? String)
        default: return .keep
        }
    }

    @Test func decisionsResolutionsAndDefaultsMatchTheWeb() throws {
        let doc = try Self.json("contribution-cases.json")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let conversions = try decoder.decode([QuantityUnitConversion].self,
                                             from: JSONSerialization.data(withJSONObject: doc["conversions"] ?? []))
        let converter = KitchenUnitConverter(conversions: conversions)
        for c in try #require(doc["decide"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            let got = ContributionMerge.decide(row: Self.row(c["row"]), incoming: Self.incoming(c["incoming"] as? [String: Any] ?? [:]),
                                               converter: converter)
            #expect(got == Self.decision(c["expect"] as? [String: Any] ?? [:]), "\(name): \(got)")
            for r in c["resolve"] as? [[String: Any]] ?? [] {
                let want = (r["expect"] as? [String: Any]).map { ContributionMerge.Resolution(amount: Self.number($0["amount"]) ?? 0, note: $0["note"] as? String) }
                #expect(ContributionMerge.resolve(got, choice: Self.choice(r["choice"] as? [String: Any] ?? [:])) == want, "\(name) resolve")
            }
            for d in c["defaultChoice"] as? [[String: Any]] ?? [] {
                let chosen = ContributionMerge.defaultChoice(got, explicitAmount: d["explicit"] as? Bool ?? false)
                #expect((chosen == .add ? "add" : "keep") == d["expect"] as? String, "\(name) default")
            }
        }
    }

    @Test func captionsAndShareRemovalMatchTheWeb() throws {
        let doc = try Self.json("contribution-cases.json")
        for c in try #require(doc["captions"] as? [[String: Any]]) {
            let names = c["names"] as? [String: String] ?? [:]
            let language = AppLanguage(rawValue: c["language"] as? String ?? "en") ?? .en
            let text = ContributionCaption.text(amount: Self.number(c["amount"]) ?? 0, shares: Self.shares(c["shares"]),
                                                recipeName: { names[String($0)] }, language: language)
            #expect(text == c["expect"] as? String, "\(c["expect"] ?? "nil")")
        }
        for c in try #require(doc["remove"] as? [[String: Any]]) {
            let result = RecipeShareSync.apply(.removed(recipeId: c["recipe"] as? Int, mealPlanId: c["mealPlan"] as? Int),
                                               amount: Self.number(c["amount"]) ?? 0, shares: Self.shares(c["shares"]))
            let want = (c["expect"] as? [String: Any]).map { RecipeShareSync.Result(amount: Self.number($0["amount"]) ?? 0, shares: Self.shares($0["shares"])) }
            #expect(result == want)
        }
    }
}
