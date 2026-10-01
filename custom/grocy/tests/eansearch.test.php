<?php
// Run: php custom/grocy/tests/eansearch.test.php
// Checks the EAN-Search source of ChainedBarcodeLookupPlugin with canned answers: food only, cache, stats, no token leak.
require __DIR__ . '/../plugins/EanSearchSource.php';

final class EanSearchProbe
{
	use EanSearchSource;

	public array $answers = [];
	public array $urls = [];
	public string $cacheFile;

	public function __construct()
	{
		$this->cacheFile = tempnam(sys_get_temp_dir(), 'eansearch');
		unlink($this->cacheFile);
	}

	public function Lookup(string $code) { return $this->FetchEanSearch($code); }
	public function Stats(): array { return $this->EanSearchCache()['stats']; }

	private function EanSearchCacheFile(): string { return $this->cacheFile; }
	private function Option(string $key, string $default): string { return $key === 'eansearch_token' ? 'tok&en' : $default; }
	private function Text($value): string { return is_scalar($value) ? trim((string) $value) : ''; }

	private function GetJson(string $url, array $headers = []): array
	{
		$this->urls[] = $url;
		$next = array_shift($this->answers);
		if ($next instanceof \Throwable) throw $next;
		return $next;
	}
}

$failures = 0;
function check(bool $ok, string $message): void
{
	global $failures;
	echo ($ok ? 'ok  ' : 'FAIL ') . $message . "\n";
	if (!$ok) $failures++;
}

$p = new EanSearchProbe();
$p->answers[] = [200, [['ean' => '3017620422003', 'name' => 'Nutella 400g', 'categoryId' => '7', 'categoryName' => 'Food', 'googleCategoryId' => '422']], '87'];
$hit = $p->Lookup('3017620422003');
check(($hit['name'] ?? '') === 'Nutella 400g' && $hit['type'] === 'food', 'a food answer becomes a product');
check(str_contains($p->urls[0], 'op=barcode-lookup') && str_contains($p->urls[0], 'token=tok%26en'), 'the token is url encoded');
$again = $p->Lookup('3017620422003');
check(count($p->urls) === 1 && $again['name'] === 'Nutella 400g', 'the second lookup comes from the cache');

$p->answers[] = [200, [['ean' => '5099750442227', 'name' => 'Thriller', 'categoryName' => 'Music', 'googleCategoryId' => '855']], '86'];
check($p->Lookup('5099750442227') === null, 'a non food answer is ignored');
$p->answers[] = [200, [['error' => 'Barcode not found']], '85'];
check($p->Lookup('4000000000001') === null, 'an unknown barcode is a miss');
$p->Lookup('4000000000001');
check(count($p->urls) === 3, 'misses are cached too');

$p->answers[] = [200, ['name' => 'Eau minérale', 'categoryName' => 'Getränke'], ''];
check(($p->Lookup('3000000000002')['name'] ?? '') === 'Eau minérale', 'a single object answer with a German drink category is food');

$p->answers[] = [403, [['error' => 'Invalid token']], ''];
try { $p->Lookup('3000000000003'); check(false, 'a refused token throws'); }
catch (\Throwable $e) { check(str_contains($e->getMessage(), 'Invalid token'), 'a refused token throws'); }

$p->answers[] = new \Exception('cURL error 28 for https://api.ean-search.org/api?token=tok&en');
try { $p->Lookup('3000000000004'); check(false, 'a network failure throws'); }
catch (\Throwable $e) { check(!str_contains($e->getMessage(), 'tok'), 'a network failure never shows the token'); }

$stats = $p->Stats();
check($stats['hits'] === 2 && $stats['not_food'] === 1 && $stats['misses'] === 1 && $stats['cached'] === 2, 'stats count hits, non food, misses and cache answers');
check($stats['credits_remaining'] === 85 && $stats['errors'] === 1, 'stats keep the credits left and the errors');
@unlink($p->cacheFile);
exit($failures === 0 ? 0 : 1);
