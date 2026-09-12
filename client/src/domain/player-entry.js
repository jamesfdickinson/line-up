export function splitPlayerNames(value) {
  return String(value ?? "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean);
}
