export function formatDate(date: Date, style: 'long' | 'short' | 'numeric' = 'long'): string {
  if (style === 'numeric') {
    return date.toISOString().slice(0, 10);
  }
  if (style === 'short') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
