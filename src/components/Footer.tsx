// The copyright and license notice: small, plain, and out of the way.
import { openUrl } from "../lib/open";

export function Footer() {
  const link = (href: string, text: string) => (
    <a href={href} onClick={(e) => { e.preventDefault(); openUrl(href); }}>{text}</a>
  );
  return (
    <footer class="footer">
      Copyright 2026 Michael A. Heroux. Code: {link("https://opensource.org/license/mit", "MIT License")}. Documents and visual content: {link("https://creativecommons.org/licenses/by/4.0/", "CC BY 4.0")}. Your photos and stories are yours.
    </footer>
  );
}
