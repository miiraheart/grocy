import Foundation
import Testing
@testable import GrocyV2

/// The web WP4 inbox case file (grocy-server custom/grocy/tests/inbox-cases.json, copied to
/// GrocyV2Tests/Fixtures/shopping-web/): the web GC.shop.inbox and InboxParser, ListRouter and InboxPlan must read,
/// route and merge a text the same way.
@MainActor
@Suite struct InboxCasesFixtureTests {
    typealias C = ContributionCasesFixtureTests

    static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(type, from: JSONSerialization.data(withJSONObject: try #require(value)))
    }

    static func text(_ value: Any?) -> String? {
        guard let value, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @Test func theParserReadsTextsLikeTheWeb() throws {
        let doc = try C.json("inbox-cases.json")
        for c in try #require(doc["parser"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            let result = InboxParser.rules(c["text"] as? String ?? "", language: .fr)
            let e = c["expect"] as? [String: Any] ?? [:]
            if let count = e["count"] as? Int { #expect(result.items.count == count, "\(name)") }
            for (i, want) in (e["names"] as? [Any] ?? []).enumerated() {
                if let want = want as? String { #expect(result.items[safe: i]?.name == want, "\(name) #\(i)") }
            }
            for (i, want) in (e["nameContains"] as? [Any] ?? []).enumerated() {
                if let want = want as? String { #expect(result.items[safe: i]?.name.contains(want) == true, "\(name) #\(i)") }
            }
            if let amounts = e["amounts"] as? [Any] { #expect(result.items.map(\.amount) == amounts.map(C.number), "\(name) amounts") }
            if let units = e["units"] as? [Any] { #expect(result.items.map(\.unit) == units.map { $0 as? String }, "\(name) units") }
            if let texts = e["qtyTexts"] as? [Any] { #expect(result.items.map(\.qtyText) == texts.map { $0 as? String }, "\(name) qty") }
            if let hints = e["hints"] as? [Any] { #expect(result.items.map(\.listHint) == hints.map { $0 as? String }, "\(name) hints") }
            if let low = C.number(e["minConfidence"]) { #expect(result.confidence >= low, "\(name)") }
            if let high = C.number(e["maxConfidence"]) { #expect(result.confidence <= high, "\(name)") }
            if let exact = C.number(e["confidence"]) { #expect(result.confidence == exact, "\(name)") }
        }
    }

    @Test func theRouterPicksTheSameList() throws {
        let doc = try #require(try C.json("inbox-cases.json")["route"] as? [String: Any])
        let groups = (doc["productGroup"] as? [String: Int] ?? [:]).reduce(into: [Int: Int]()) { $0[Int($1.key) ?? 0] = $1.value }
        for c in try #require(doc["cases"] as? [[String: Any]]) {
            let locked = Set(c["locked"] as? [Int] ?? [])
            let listMemory = c["listMemory"] as? [String: Any] ?? [:]
            let lists = (doc["lists"] as? [[String: Any]] ?? []).map { l -> ListRouteContext.List in
                let id = l["id"] as? Int ?? 0
                return ListRouteContext.List(id: id, name: l["name"] as? String ?? "", type: ListType(rawValue: l["type"] as? String ?? "") ?? .grocery,
                                             locked: locked.contains(id),
                                             memory: ShoppingDocCodec.decode(Self.text(listMemory[String(id)]), as: ListMemoryDoc.self).value)
            }
            let memory = (c["productMemory"] as? [String: Any] ?? [:]).reduce(into: [Int: ProductMemoryDoc]()) {
                $0[Int($1.key) ?? 0] = ShoppingDocCodec.decode(Self.text($1.value), as: ProductMemoryDoc.self).value
            }
            let context = ListRouteContext(lists: lists, productMemory: memory, productGroup: groups, currentListId: 1)
            let got = ListRouter.route(productId: c["productId"] as? Int, key: c["key"] as? String ?? "", hint: c["hint"] as? String, context: context)
            #expect(got == c["expect"] as? Int, "\(c["name"] ?? "")")
        }
    }

    static func action(_ action: InboxApplyLine.Action?) -> (String, Double?)? {
        switch action {
        case nil: return nil
        case .create: return ("create", nil)
        case .add(let amount): return ("add", amount)
        case .set(let amount, _): return ("set", amount)
        case .reopen(let amount): return ("reopen", amount)
        case .keep: return ("keep", nil)
        }
    }

    @Test func plansMatchTheWeb() throws {
        let p = try #require(try C.json("inbox-cases.json")["plan"] as? [String: Any])
        let catalog = try Self.decode(CatalogData.self, p["catalog"])
        let shopping = ShoppingData(lists: try Self.decode([ShoppingList].self, p["lists"]), items: try Self.decode([ShoppingListItem].self, p["rows"]))
        let snapshot = InboxSnapshot(catalog: catalog, rows: shopping.items,
                                     route: ListRouteContext(shopping: shopping, catalog: catalog, currentListId: p["currentListId"] as? Int ?? 1))
        for c in try #require(p["cases"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? "", entryId = c["entryId"] as? String
            let lines = InboxPlan.build(InboxParser.rules(c["text"] as? String ?? "", language: .fr).items, entryId: entryId, snapshot: snapshot)
            let expect = c["expect"] as? [[String: Any]] ?? []
            #expect(lines.count == expect.count, "\(name)")
            for (i, e) in expect.enumerated() where i < lines.count {
                let line = lines[i]
                #expect(line.name == e["name"] as? String && line.productId == e["productId"] as? Int && line.listId == e["listId"] as? Int, "\(name) #\(i)")
                #expect(line.amount == C.number(e["amount"]), "\(name) #\(i) amount")
                if e.keys.contains("quId") { #expect(line.quId == e["quId"] as? Int, "\(name) #\(i) quId") }
                if e.keys.contains("qtyText") { #expect(line.qtyText == e["qtyText"] as? String, "\(name) #\(i) qtyText") }
                #expect(line.decision == C.decision(e["decision"] as? [String: Any] ?? [:]), "\(name) #\(i) \(line.decision)")
                #expect((line.choice == .add ? "add" : "keep") == e["choice"] as? String, "\(name) #\(i) choice")
                let got = Self.action(line.applyLine?.action)
                if let want = e["action"] as? [String: Any] {
                    #expect(got?.0 == want["kind"] as? String, "\(name) #\(i) action")
                    if let amount = C.number(want["amount"]) { #expect(got?.1 == amount, "\(name) #\(i) action amount") }
                } else {
                    #expect(got == nil, "\(name) #\(i) no write")
                }
                if let draft = e["draft"] as? [String: Any] {
                    #expect(line.applyLine?.draft.amount == C.number(draft["amount"]) && line.applyLine?.draft.qtyText == draft["qtyText"] as? String,
                            "\(name) #\(i) draft")
                }
            }
            if let move = c["move"] as? [String: Any], let index = move["line"] as? Int, index < lines.count {
                let moved = InboxPlan.moved(lines[index], to: move["to"] as? Int ?? 0, entryId: entryId, snapshot: snapshot)
                let want = move["expect"] as? [String: Any] ?? [:]
                #expect(moved.decision == C.decision(want["decision"] as? [String: Any] ?? [:]), "\(name) moved")
                #expect((moved.choice == .add ? "add" : "keep") == want["choice"] as? String, "\(name) moved choice")
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
