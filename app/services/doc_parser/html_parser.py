"""HTML document parser using BeautifulSoup + lxml."""

from __future__ import annotations

from bs4 import BeautifulSoup

from app.services.doc_parser.base import BaseDocParser, ParsedDocument

_NOISE_TAGS = {"script", "style", "nav", "footer", "header", "aside", "noscript", "iframe", "object", "embed"}


class HtmlParser(BaseDocParser):
    name = "html"

    def can_parse(self, mime_type: str, filename: str) -> bool:
        return mime_type in ("text/html", "application/xhtml+xml") or filename.endswith(
            (".html", ".htm")
        )

    def _parse_sync(self, content: bytes, filename: str) -> ParsedDocument:
        soup = BeautifulSoup(content, "lxml")

        for tag in soup.find_all(list(_NOISE_TAGS)):
            tag.decompose()

        headings = self._extract_headings(soup)
        code_blocks = self._extract_code_blocks(soup)
        images = self._extract_images(soup)
        tables = self._extract_tables(soup)

        body = soup.find("body") or soup
        text = body.get_text(separator="\n", strip=True)

        title_tag = soup.find("title")
        title = title_tag.get_text(strip=True) if title_tag else filename

        return ParsedDocument(
            text=text,
            headings=headings,
            code_blocks=code_blocks,
            images=images,
            tables=tables,
            metadata={"title": title},
        )

    def _extract_headings(self, soup: BeautifulSoup) -> list[dict]:
        headings: list[dict] = []
        for level in range(1, 7):
            for tag in soup.find_all(f"h{level}"):
                headings.append({
                    "level": level,
                    "text": tag.get_text(strip=True),
                    "position": 0,
                })
        return headings

    def _extract_code_blocks(self, soup: BeautifulSoup) -> list[dict]:
        blocks: list[dict] = []
        for tag in soup.find_all("pre"):
            code_tag = tag.find("code")
            code = code_tag.get_text() if code_tag else tag.get_text()
            lang = ""
            if code_tag and code_tag.get("class"):
                for cls in code_tag["class"]:
                    if cls.startswith("language-") or cls.startswith("lang-"):
                        lang = cls.split("-", 1)[1]
                        break
            blocks.append({"language": lang, "code": code, "position": 0})
        return blocks

    def _extract_images(self, soup: BeautifulSoup) -> list[dict]:
        images: list[dict] = []
        for tag in soup.find_all("img"):
            images.append({
                "src": tag.get("src", ""),
                "alt": tag.get("alt", ""),
                "position": 0,
            })
        return images

    def _extract_tables(self, soup: BeautifulSoup) -> list[dict]:
        tables: list[dict] = []
        for table_tag in soup.find_all("table"):
            headers: list[str] = []
            rows: list[list[str]] = []
            for tr in table_tag.find_all("tr"):
                cells = [
                    td.get_text(strip=True)
                    for td in tr.find_all(["td", "th"])
                ]
                if not cells:
                    continue
                is_header_row = all(
                    td.name == "th" or td.find_parent("thead") is not None
                    for td in tr.find_all(["td", "th"])
                )
                if is_header_row and not headers:
                    headers = cells
                else:
                    rows.append(cells)
            if headers or rows:
                tables.append({"headers": headers, "rows": rows, "position": 0})
        return tables
