<?php

use Grocy\Helpers\BaseBarcodeLookupPlugin;
use GuzzleHttp\Client;

require_once __DIR__ . '/EanSearchSource.php';

class ChainedBarcodeLookupPlugin extends BaseBarcodeLookupPlugin
{
	use EanSearchSource;

	public const PLUGIN_NAME = 'Open Food Facts + EAN-Search + EAN-DB + UPCitemdb';

	private const TIMEOUT = 2;
	private const LOCATION_FRIDGE = 2;
	private const LOCATION_PANTRY = 3;
	private const LOCATION_FREEZER = 4;
	private const UNIT_PIECE = 2;
	private const UNIT_PACK = 3;

	private const SOURCE_LABELS = [
		'food' => 'Open Food Facts (ODbL)',
		'beauty' => 'Open Beauty Facts (ODbL)',
		'product' => 'Open Products Facts (ODbL)',
		'petfood' => 'Open Pet Food Facts (ODbL)',
		'eansearch' => 'EAN-Search',
		'eandb' => 'EAN-DB',
		'upcitemdb' => 'UPCitemdb'
	];

	private const FREEZER_TAGS = ['en:frozen-foods', 'en:ice-creams', 'en:frozen-desserts', 'en:ice-creams-and-sorbets'];

	private const FRIDGE_TAGS = [
		'en:dairies', 'en:cheeses', 'en:yogurts', 'en:butters', 'en:creams', 'en:fermented-milk-products',
		'en:meats', 'en:poultries', 'en:prepared-meats', 'en:hams', 'en:sausages',
		'en:fishes', 'en:seafood', 'en:smoked-fishes', 'en:eggs', 'en:fresh-pasta', 'en:fresh-foods'
	];

	private const FREEZER_WORDS = '/surgel|congel|frozen|ice cream|crème glacée|creme glacee/iu';

	private const FRIDGE_WORDS = '/dairy|dairies|cheese|fromage|yog(h)?o?urt|yaourt|butter|beurre|crème fraîche|creme fraiche|meat|viande|poultry|volaille|charcuterie|fish|poisson|seafood|fruits de mer|egg|œuf|oeuf|produits frais|fresh food|pâtes fraîches|pates fraiches/iu';

	private const NOT_FRIDGE_WORDS = '/peanut|nut butter|cacahu|body butter|shea|karité/iu';

	private const DRY_GOODS_WORDS = '/biscuit|gâteau|gateau|sablé|cookie|galette|chips|crackers|brioche|pâte à tartiner|chocolat|céréales|lessive|savon|shampo/iu';

	private const PACK_PATTERN = '/\d\s*[x×]\s*\d|\bx\s*\d+|\d+\s*x\b|lot de \d|pack of \d|\d+\s*(sachets|capsules|dosettes|pots|tranches|rouleaux)\b/iu';

	private ?array $fileOptions = null;

	protected function ExecuteLookup($barcode)
	{
		$code = preg_replace('/[^0-9]/', '', (string) $barcode);
		if ($code === '')
		{
			return null;
		}

		$merged = null;
		$failures = [];
		$answered = 0;

		foreach ($this->Sources() as $source => $fetch)
		{
			try
			{
				$found = $this->{$fetch}($code);
				$answered++;
			}
			catch (\Throwable $ex)
			{
				$failures[] = $source . ': ' . $ex->getMessage();
				continue;
			}

			if ($found === null)
			{
				continue;
			}

			$found['sources'] = [self::SOURCE_LABELS[$source === 'off' ? ($found['type'] ?: 'food') : $source] ?? self::SOURCE_LABELS['food']];
			$merged = $merged === null ? $found : $this->FillMissing($merged, $found);
			if ($merged['name'] !== '')
			{
				return $this->BuildOutput($barcode, $merged);
			}
		}

		if ($answered === 0 && count($failures) > 0)
		{
			throw new \Exception('Every barcode source failed: ' . implode(' | ', $failures));
		}

		return null;
	}

	private function Sources(): array
	{
		$sources = ['off' => 'FetchOpenFoodFacts'];
		if ($this->Option('eansearch_token', '') !== '')
		{
			$sources['eansearch'] = 'FetchEanSearch';
		}
		if ($this->Option('eandb_token', '') !== '')
		{
			$sources['eandb'] = 'FetchEanDb';
		}
		if (!in_array(strtolower($this->Option('enable_upcitemdb', '1')), ['0', 'false', 'no', 'off'], true))
		{
			$sources['upcitemdb'] = 'FetchUpcItemDb';
		}

		return $sources;
	}

	private function FetchOpenFoodFacts(string $code): ?array
	{
		$lang = $this->Lang();
		$fields = implode(',', [
			'product_name', 'product_name_' . $lang, 'generic_name_' . $lang, 'brands', 'quantity',
			'product_quantity', 'product_quantity_unit', 'image_front_url', 'image_url', 'categories_tags', 'product_type'
		]);
		[$status, $data] = $this->GetJson('https://world.openfoodfacts.org/api/v3/product/' . $code . '?product_type=all&lc=' . $lang . '&fields=' . $fields);

		if ($status == 404 || ($data['result']['id'] ?? '') === 'product_not_found')
		{
			return null;
		}
		if ($status != 200 || !is_array($data['product'] ?? null))
		{
			throw new \Exception("HTTP $status");
		}

		$p = $data['product'];
		$quantity = $this->Text($p['quantity'] ?? '');
		if ($quantity === '' && !empty($p['product_quantity']))
		{
			$quantity = $this->Text($p['product_quantity'] . ' ' . ($p['product_quantity_unit'] ?? ''));
		}

		return [
			'name' => $this->FirstText([$p['product_name_' . $lang] ?? '', $p['product_name'] ?? '', $p['generic_name_' . $lang] ?? '']),
			'brand' => $this->Text(explode(',', (string) ($p['brands'] ?? ''))[0]),
			'quantity' => $quantity,
			'image' => $this->FirstText([$p['image_front_url'] ?? '', $p['image_url'] ?? '']),
			'tags' => array_values(array_filter((array) ($p['categories_tags'] ?? []), 'is_string')),
			'words' => [],
			'type' => (string) ($p['product_type'] ?? 'food')
		];
	}

	private function FetchEanDb(string $code): ?array
	{
		[$status, $data] = $this->GetJson('https://ean-db.com/api/v2/product/' . $code, ['Authorization' => 'Bearer ' . $this->Option('eandb_token', '')]);
		if ($status == 404)
		{
			return null;
		}
		if ($status == 403)
		{
			throw new \Exception('access denied or no requests left');
		}
		if ($status != 200 || !is_array($data['product'] ?? null))
		{
			throw new \Exception("HTTP $status");
		}

		$p = $data['product'];
		$words = [];
		foreach ((array) ($p['categories'] ?? []) as $category)
		{
			$words[] = $this->Localized($category['titles'] ?? []);
		}
		$generic = $p['metadata']['generic'] ?? [];

		return [
			'name' => $this->Localized($p['titles'] ?? []),
			'brand' => $this->Localized($p['manufacturer']['titles'] ?? []),
			'quantity' => $this->Measurement($generic['weight']['net'] ?? null) ?: $this->Measurement($generic['volume'] ?? null) ?: $this->Measurement($generic['weight']['unknown'] ?? null),
			'image' => $this->Text($p['images'][0]['url'] ?? ''),
			'tags' => [],
			'words' => array_values(array_filter($words)),
			'type' => ''
		];
	}

	private function FetchUpcItemDb(string $code): ?array
	{
		[$status, $data] = $this->GetJson('https://api.upcitemdb.com/prod/trial/lookup?upc=' . $code);
		if ($status == 404 || $status == 429 || ($status == 200 && empty($data['items'])))
		{
			return null;
		}
		if ($status != 200)
		{
			throw new \Exception("HTTP $status " . ($data['code'] ?? ''));
		}

		$item = $data['items'][0];
		$title = preg_replace('/\((B0[0-9A-Z]{8})\)|\s*,\s*(?=,)/u', '', (string) ($item['title'] ?? ''));
		$size = $this->Text($item['size'] ?? '');

		return [
			'name' => $this->Text($title),
			'brand' => $this->Text($item['brand'] ?? ''),
			'quantity' => preg_match('/^[\d.,]+\s*(mg|g|kg|ml|cl|l|oz|fl oz|lb)$/iu', $size) ? $size : '',
			'image' => $this->Text($item['images'][0] ?? ''),
			'tags' => [],
			'words' => [$this->Text($item['category'] ?? '')],
			'type' => ''
		];
	}

	private function BuildOutput(string $barcode, array $product): array
	{
		$quId = $this->ValidId($this->QuantityUnits, preg_match(self::PACK_PATTERN, $product['quantity']) ? self::UNIT_PACK : self::UNIT_PIECE, 'product_presets_qu_id');
		$description = implode(' - ', array_filter([$product['brand'], $product['quantity'], 'Source: ' . implode(', ', array_unique($product['sources']))]));

		return [
			'name' => $this->ProductName($product),
			'description' => htmlspecialchars($description, ENT_NOQUOTES),
			'location_id' => $this->ValidId($this->Locations, $this->LocationFor($product), 'product_presets_location_id'),
			'qu_id_purchase' => $quId,
			'qu_id_stock' => $quId,
			'__qu_factor_purchase_to_stock' => 1,
			'__barcode' => $barcode,
			'__image_url' => preg_match('/^https?:\/\//', $product['image']) ? $product['image'] : ''
		];
	}

	private function ProductName(array $product): string
	{
		$name = $product['name'];
		if ($product['brand'] !== '' && mb_stripos($name, $product['brand']) === false)
		{
			$name = $product['brand'] . ' ' . $name;
		}

		$compact = fn(string $text) => mb_strtolower(str_replace(' ', '', $text));
		if ($product['quantity'] !== '' && mb_strpos($compact($name), $compact($product['quantity'])) === false)
		{
			$name .= ' ' . $product['quantity'];
		}

		return mb_substr($this->Text($name), 0, 150);
	}

	private function LocationFor(array $product): int
	{
		$words = implode(' | ', $product['words']);
		if (count($product['tags']) === 0 && $words === '' && !preg_match(self::DRY_GOODS_WORDS, $product['name']))
		{
			$words = $product['name'];
		}

		if (count(array_intersect($product['tags'], self::FREEZER_TAGS)) > 0 || preg_match(self::FREEZER_WORDS, $words))
		{
			return self::LOCATION_FREEZER;
		}

		$isFood = in_array($product['type'], ['', 'food'], true);
		$fridgeTag = count(array_intersect($product['tags'], self::FRIDGE_TAGS)) > 0;
		$fridgeWord = preg_match(self::FRIDGE_WORDS, $words) && !preg_match(self::NOT_FRIDGE_WORDS, $words);

		return $isFood && ($fridgeTag || $fridgeWord) ? self::LOCATION_FRIDGE : self::LOCATION_PANTRY;
	}

	private function ValidId(array $rows, int $wanted, string $presetKey): int
	{
		if (FindObjectInArrayByPropertyValue($rows, 'id', $wanted) !== null)
		{
			return $wanted;
		}
		if (($this->UserSettings[$presetKey] ?? -1) != -1)
		{
			return (int) $this->UserSettings[$presetKey];
		}

		return (int) $rows[0]->id;
	}

	private function GetJson(string $url, array $headers = []): array
	{
		$client = new Client(['http_errors' => false, 'timeout' => self::TIMEOUT, 'connect_timeout' => self::TIMEOUT, 'allow_redirects' => true]);
		$response = $client->request('GET', $url, ['headers' => $headers + [
			'User-Agent' => 'grocy-audibox/1.0 (' . $this->Option('contact', 'https://grocy.info') . ')',
			'Accept' => 'application/json'
		]]);

		$data = json_decode(mb_convert_encoding((string) $response->getBody(), 'UTF-8', 'UTF-8'), true);
		return [$response->getStatusCode(), is_array($data) ? $data : [], $response->getHeaderLine('X-Credits-Remaining')];
	}

	private function Option(string $key, string $default): string
	{
		$env = getenv('CHAINED_LOOKUP_' . strtoupper($key));
		if ($env !== false && trim($env) !== '')
		{
			return trim($env);
		}

		if ($this->fileOptions === null)
		{
			$file = __DIR__ . '/ChainedBarcodeLookupPlugin.json';
			$decoded = is_readable($file) ? json_decode((string) file_get_contents($file), true) : null;
			$this->fileOptions = is_array($decoded) ? $decoded : [];
		}

		$value = $this->fileOptions[$key] ?? '';
		return is_scalar($value) && trim((string) $value) !== '' ? trim((string) $value) : $default;
	}

	private function FillMissing(array $base, array $extra): array
	{
		foreach ($extra as $key => $value)
		{
			if (empty($base[$key]))
			{
				$base[$key] = $value;
			}
		}
		$base['sources'] = array_merge($base['sources'], $extra['sources']);

		return $base;
	}

	private function Lang(): string
	{
		return substr((string) (defined('GROCY_LOCALE') ? GROCY_LOCALE : GROCY_DEFAULT_LOCALE), 0, 2);
	}

	private function Localized(array $titles): string
	{
		return $this->FirstText([$titles[$this->Lang()] ?? '', $titles['en'] ?? '', reset($titles) ?: '']);
	}

	private function Measurement($measurement): string
	{
		$value = is_array($measurement) ? ($measurement['equals'] ?? null) : null;
		return is_array($value) && isset($value['value']) ? $this->Text($value['value'] . ' ' . ($value['unit'] ?? '')) : '';
	}

	private function FirstText(array $values): string
	{
		foreach ($values as $value)
		{
			$text = $this->Text($value);
			if ($text !== '')
			{
				return $text;
			}
		}

		return '';
	}

	private function Text($value): string
	{
		if (!is_scalar($value))
		{
			return '';
		}

		$text = preg_replace('/\s+/u', ' ', html_entity_decode((string) $value, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
		$text = preg_replace('/\s*(℮|\be)$/u', '', trim($text));
		return trim($text, " ,;-");
	}
}
