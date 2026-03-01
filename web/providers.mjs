import { XMLParser } from 'fast-xml-parser';

const BUILT_IN_PROVIDERS = [
  {
    id: 'nasa-iotd',
    name: 'NASA Image of the Day',
    feedUrl: 'https://www.nasa.gov/feeds/iotd-feed/',
    builtin: true,
  },
  {
    id: 'natgeo-potd',
    name: 'National Geographic POTD',
    feedUrl: 'https://feeds.feedburner.com/natgeotv/ca/featured/POD',
    builtin: true,
  },
  {
    id: 'wikimedia-potd',
    name: 'Wikimedia Commons POTD',
    feedUrl: 'https://commons.wikimedia.org/w/api.php?action=featuredfeed&feed=potd&feedformat=atom&language=en',
    builtin: true,
  },
  {
    id: 'bluebrook',
    name: 'Bluebrook Photo',
    feedUrl: 'https://photo.bluebrook.com/rss.xml',
    builtin: true,
  },
  {
    id: 'bing-iotd',
    name: 'Bing Image of the Day',
    feedUrl: 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1',
    type: 'bing-json',
    builtin: true,
  },
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function extractImageFromHtml(html) {
  if (!html) return null;
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function extractFromRssItem(item) {
  if (item.enclosure?.['@_url']) return item.enclosure['@_url'];
  if (item['media:content']?.['@_url']) return item['media:content']['@_url'];
  if (item['media:thumbnail']?.['@_url']) return item['media:thumbnail']['@_url'];

  const desc = item.description || item['content:encoded'] || '';
  const imgFromDesc = extractImageFromHtml(typeof desc === 'string' ? desc : '');
  if (imgFromDesc) return imgFromDesc;

  return null;
}

function extractFromAtomEntry(entry) {
  const links = Array.isArray(entry.link) ? entry.link : [entry.link].filter(Boolean);
  const enclosure = links.find(l => l['@_rel'] === 'enclosure' && l['@_href']);
  if (enclosure) return enclosure['@_href'];

  const content = entry.content?.['#text'] || entry.content || entry.summary?.['#text'] || entry.summary || '';
  const imgFromContent = extractImageFromHtml(typeof content === 'string' ? content : '');
  if (imgFromContent) return imgFromContent;

  return null;
}

async function fetchRssFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'node-samsung-emdx/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  const text = await res.text();
  const parsed = xmlParser.parse(text);

  // RSS 2.0
  if (parsed.rss?.channel) {
    const items = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item].filter(Boolean);
    const item = items[0];
    if (!item) throw new Error('No items in RSS feed');
    const imageUrl = extractFromRssItem(item);
    return {
      title: item.title || 'Untitled',
      imageUrl,
      date: item.pubDate || null,
    };
  }

  // Atom
  if (parsed.feed?.entry) {
    const entries = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : [parsed.feed.entry].filter(Boolean);
    const entry = entries[0];
    if (!entry) throw new Error('No entries in Atom feed');
    const imageUrl = extractFromAtomEntry(entry);
    return {
      title: entry.title?.['#text'] || entry.title || 'Untitled',
      imageUrl,
      date: entry.updated || entry.published || null,
    };
  }

  throw new Error('Unrecognized feed format');
}

async function fetchBingImage() {
  const res = await fetch(
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US',
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Bing API returned ${res.status}`);
  const data = await res.json();
  const img = data.images?.[0];
  if (!img) throw new Error('No Bing image found');
  return {
    title: img.title || img.copyright || 'Bing Image of the Day',
    imageUrl: `https://www.bing.com${img.url}`,
    date: img.startdate || null,
  };
}

export async function fetchFromProvider(provider) {
  let result;
  if (provider.type === 'bing-json') {
    result = await fetchBingImage();
  } else {
    result = await fetchRssFeed(provider.feedUrl);
  }

  if (!result.imageUrl) {
    throw new Error(`No image found in feed: ${provider.name}`);
  }

  result.source = provider.name;
  result.providerId = provider.id;
  return result;
}

export async function downloadImage(imageUrl) {
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': 'node-samsung-emdx/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export { BUILT_IN_PROVIDERS };
