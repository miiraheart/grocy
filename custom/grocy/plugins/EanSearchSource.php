<?php

/// EAN-Search (ean-search.org) for ChainedBarcodeLookupPlugin: asked only after Open Food Facts misses, keeps food
/// only, and caches every answer in a file next to the plugin so a barcode never costs two credits.
/// The token is the eansearch_token option (plugin JSON file on the server or CHAINED_LOOKUP_EANSEARCH_TOKEN).
trait EanSearchSource
{
	private static int $eanSearchHitDays = 365;
	private static int $eanSearchMissDays = 30;
	private static int $eanSearchMaxCodes = 5000;

	private static string $eanSearchFoodWords = '/food|beverage|drink|grocer|nourriture|aliment|boisson|épicerie|epicerie|lebensmittel|getränk|getrank/iu';
	private static array $eanSearchFoodGoogleIds = [412, 413, 422];

	private function FetchEanSearch(string $code): ?array
	{
		$cache = $this->EanSearchCache();
		$cached = $cache['codes'][$code] ?? null;
		if (is_array($cached) && $this->EanSearchFresh($cached))
		{
			$cache['stats']['cached'] = ($cache['stats']['cached'] ?? 0) + 1;
			$this->EanSearchSave($cache);
			return $cached['product'];
		}

		$url = 'https://api.ean-search.org/api?op=barcode-lookup&format=json&ean=' . $code . '&token=' . rawurlencode($this->Option('eansearch_token', ''));
		try
		{
			$answer = $this->GetJson($url);
		}
		catch (\Throwable $ex)
		{
			throw new \Exception('EAN-Search unreachable');
		}
		[$status, $data] = $answer;
		$cache['stats']['calls'] = ($cache['stats']['calls'] ?? 0) + 1;
		$cache['stats']['last_call'] = date('c');
		if (isset($answer[2]) && $answer[2] !== '')
		{
			$cache['stats']['credits_remaining'] = (int) $answer[2];
		}

		try
		{
			$product = $this->ParseEanSearch($status, $data);
		}
		catch (\Throwable $ex)
		{
			$cache['stats']['errors'] = ($cache['stats']['errors'] ?? 0) + 1;
			$this->EanSearchSave($cache);
			throw $ex;
		}

		$outcome = $product === null ? 'misses' : ($product === false ? 'not_food' : 'hits');
		$cache['stats'][$outcome] = ($cache['stats'][$outcome] ?? 0) + 1;
		$product = $product ?: null;
		$cache['codes'][$code] = ['at' => time(), 'product' => $product];
		$this->EanSearchSave($cache);
		return $product;
	}

	/// null when the barcode is unknown, false when it is not food, else the product in the plugin's shape.
	private function ParseEanSearch(int $status, array $data)
	{
		$row = array_is_list($data) ? ($data[0] ?? []) : $data;
		$error = is_array($row) ? (string) ($row['error'] ?? '') : '';
		if ($status == 404 || stripos($error, 'not found') !== false || ($status == 200 && $data === []))
		{
			return null;
		}
		if ($status != 200 || $error !== '' || !is_array($row))
		{
			throw new \Exception('HTTP ' . $status . ($error !== '' ? ' ' . $error : ''));
		}

		$category = $this->Text($row['categoryName'] ?? '');
		$google = (int) ($row['googleCategoryId'] ?? 0);
		if (!preg_match(self::$eanSearchFoodWords, $category) && !in_array($google, self::$eanSearchFoodGoogleIds, true))
		{
			return false;
		}

		$name = $this->Text($row['name'] ?? '');
		if ($name === '')
		{
			return null;
		}

		return ['name' => $name, 'brand' => '', 'quantity' => '', 'image' => '', 'tags' => [], 'words' => [$category], 'type' => 'food'];
	}

	private function EanSearchFresh(array $cached): bool
	{
		$days = $cached['product'] === null ? self::$eanSearchMissDays : self::$eanSearchHitDays;
		return (int) ($cached['at'] ?? 0) > time() - $days * 86400;
	}

	private function EanSearchCacheFile(): string
	{
		return __DIR__ . '/ChainedBarcodeLookupPlugin.eansearch-cache.json';
	}

	private function EanSearchCache(): array
	{
		$file = $this->EanSearchCacheFile();
		$decoded = is_readable($file) ? json_decode((string) file_get_contents($file), true) : null;
		$cache = is_array($decoded) ? $decoded : [];
		return ['stats' => (array) ($cache['stats'] ?? []), 'codes' => (array) ($cache['codes'] ?? [])];
	}

	private function EanSearchSave(array $cache): void
	{
		if (count($cache['codes']) > self::$eanSearchMaxCodes)
		{
			uasort($cache['codes'], fn($a, $b) => ($b['at'] ?? 0) <=> ($a['at'] ?? 0));
			$cache['codes'] = array_slice($cache['codes'], 0, self::$eanSearchMaxCodes, true);
		}
		@file_put_contents($this->EanSearchCacheFile(), json_encode($cache, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
	}
}
