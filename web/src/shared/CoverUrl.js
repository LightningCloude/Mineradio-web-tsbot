const QQ_COVER_PATTERN =
  /^(?:https?:)?\/\/y\.gtimg\.cn\/music\/photo_new\/(.+)$/i;


export function resolveCoverUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  const match = url.match(QQ_COVER_PATTERN);
  return match ? `/cover/${match[1]}` : url;
}
