#!/usr/bin/env python3
"""Product master data cleanup (beads projects-arg and projects-7z79).

Dry run by default: reads the Grocy instance with GET requests only and prints
what would change. Writes only with --apply AND an explicit --target URL.
Idempotent: a second run finds nothing to do.

Credentials: GROCY_API_KEY (and GROCY_URL) from the environment, else from
~/.config/grocy/credentials. The key is never printed.

  grocy-master-cleanup.py                                  # dry run on GROCY_URL
  grocy-master-cleanup.py --target https://grocy-test.audibox.cc --apply
"""
import argparse
import datetime
import json
import os
import pathlib
import sys
import unicodedata
import urllib.error
import urllib.request

CREDENTIALS = pathlib.Path.home() / ".config/grocy/credentials"
BACKUPS = pathlib.Path.home() / ".config/grocy/backups"

# (name keyword, due_type, days after opening, days after freezing, days after thawing); None = leave as is.
# due_type 1 = best before (DDM), 2 = expiration (DLC). Days are only filled where Grocy still has 0.
PRODUCT_RULES = [
    ("creme fraiche", 2, 3, 90, 1),
    ("mascarpone", 2, 3, 90, 1),
    ("oeuf", 2, None, None, None),
    ("beurre", None, 30, 180, 1),
    ("chocolat", None, 60, None, None),
]
NEW_UNITS = [("g", "g"), ("ml", "ml"), ("cl", "cl")]
USER_SETTINGS = {"product_presets_location_id": 3, "product_presets_qu_id": 2}
FIELDS = ("due_type", "default_best_before_days_after_open", "default_best_before_days_after_freezing",
          "default_best_before_days_after_thawing")


def credentials():
    values = {}
    if CREDENTIALS.exists():
        for line in CREDENTIALS.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                name, value = line.split("=", 1)
                values[name.strip()] = value.strip().strip('"').strip("'")
    values.update({k: os.environ[k] for k in ("GROCY_URL", "GROCY_API_KEY") if os.environ.get(k)})
    if not values.get("GROCY_API_KEY"):
        sys.exit("no GROCY_API_KEY in the environment or ~/.config/grocy/credentials")
    return values


class Grocy:
    def __init__(self, base, key):
        self.base = base.rstrip("/")
        self.key = key

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + "/api" + path, data=data, method=method,
                                     headers={"GROCY-API-KEY": self.key, "Content-Type": "application/json",
                                              "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read()
        except urllib.error.HTTPError as err:
            sys.exit(f"{method} {path} -> HTTP {err.code} {err.read()[:300]!r}")
        return json.loads(raw) if raw.strip() else None


def fold(text):
    text = text.replace("œ", "oe").replace("Œ", "Oe")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)).lower()


def clean_dashes(text):
    for dash in ("—", "–"):
        text = text.replace(f" {dash} ", ", ").replace(dash, "-")
    return text


def product_changes(product):
    change = {}
    name = fold(product["name"])
    rule = next((r for r in PRODUCT_RULES if r[0] in name), None)
    if rule:
        for field, value in zip(FIELDS, rule[1:]):
            current = int(product.get(field) or 0)
            if value is None:
                continue
            if field == "due_type" and current != value:
                change[field] = value
            elif field != "due_type" and current == 0:
                change[field] = value
    description = product.get("description") or ""
    if clean_dashes(description) != description:
        change["description"] = clean_dashes(description)
    return change


def plan(grocy):
    products = grocy.call("GET", "/objects/products")
    units = grocy.call("GET", "/objects/quantity_units")
    settings = grocy.call("GET", "/user/settings")
    product_plan = [(p, c) for p in products if (c := product_changes(p))]
    unit_names = {fold(u["name"]) for u in units}
    unit_plan = [(n, p) for n, p in NEW_UNITS if fold(n) not in unit_names]
    setting_plan = {k: v for k, v in USER_SETTINGS.items() if str(settings.get(k)) != str(v)}
    return product_plan, unit_plan, setting_plan, {"units": units, "settings": settings}


def report(base, product_plan, unit_plan, setting_plan, context):
    lines = [f"Grocy master data cleanup, {base}, {datetime.datetime.now().isoformat(timespec='seconds')}"]
    lines.append(f"Products to change: {len(product_plan)}")
    for product, change in product_plan:
        lines.append(f"  #{product['id']} {product['name']}")
        for field, value in change.items():
            lines.append(f"    {field}: {product.get(field)!r} -> {value!r}")
    lines.append(f"Units to add: {', '.join(n for n, _ in unit_plan) or 'none'}")
    lines.append("  existing: " + ", ".join(f"{u['id']}={u['name']}" for u in context["units"]))
    lines.append(f"User settings to set: {len(setting_plan)}")
    for key, value in setting_plan.items():
        lines.append(f"    {key}: {context['settings'].get(key)!r} -> {value!r}")
    if not (product_plan or unit_plan or setting_plan):
        lines.append("Nothing to do.")
    return "\n".join(lines)


def apply(grocy, product_plan, unit_plan, setting_plan, context):
    BACKUPS.mkdir(parents=True, exist_ok=True)
    host = grocy.base.split("//")[-1].replace("/", "_")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS / f"master-cleanup-{host}-{stamp}.json"
    backup.write_text(json.dumps({
        "products": {p["id"]: {k: p.get(k) for k in c} for p, c in product_plan},
        "settings": {k: context["settings"].get(k) for k in setting_plan},
    }, ensure_ascii=False, indent=2))
    print(f"before-values saved to {backup}")
    for product, change in product_plan:
        grocy.call("PUT", f"/objects/products/{product['id']}", change)
    for name, plural in unit_plan:
        grocy.call("POST", "/objects/quantity_units", {"name": name, "name_plural": plural})
    for key, value in setting_plan.items():
        grocy.call("PUT", f"/user/settings/{key}", {"value": value})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", help="Grocy base URL; required with --apply")
    parser.add_argument("--apply", action="store_true", help="write the changes")
    parser.add_argument("--report", help="also write the report to this file")
    args = parser.parse_args()
    creds = credentials()
    if args.apply and not args.target:
        sys.exit("--apply needs an explicit --target URL")
    base = args.target or creds.get("GROCY_URL")
    if not base:
        sys.exit("no --target and no GROCY_URL")
    grocy = Grocy(base, creds["GROCY_API_KEY"])
    planned = plan(grocy)
    text = report(grocy.base, *planned)
    print(text)
    if args.report:
        pathlib.Path(args.report).write_text(text + "\n")
    if args.apply and any(planned[:3]):
        apply(grocy, *planned)
        print("applied; checking again")
        after = plan(grocy)
        print(report(grocy.base, *after))
        if any(after[:3]):
            sys.exit("changes remain after apply")


if __name__ == "__main__":
    main()
