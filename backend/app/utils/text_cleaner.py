import re
from bs4 import BeautifulSoup


def html_to_text(html_content: str) -> str:
    """Convert HTML chapter content to clean plain text for TTS."""
    soup = BeautifulSoup(html_content, "lxml")

    # Remove non-speech elements
    for tag in soup(["script", "style", "img", "figure", "figcaption", "table", "nav", "aside"]):
        tag.decompose()

    # Convert block elements to newlines
    for tag in soup.find_all(["p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6"]):
        tag.insert_before("\n")
        tag.insert_after("\n")

    text = soup.get_text(separator=" ")
    return clean_text(text)


def clean_text(text: str) -> str:
    """Normalize whitespace and remove TTS-unfriendly characters."""
    # Collapse multiple newlines to max 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Collapse spaces/tabs on each line
    text = re.sub(r"[ \t]+", " ", text)
    # Strip trailing/leading whitespace per line
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(lines)
    # Remove lines that are only punctuation or numbers (footnote markers)
    text = re.sub(r"^\s*[\[\(]?\d+[\]\)]?\s*$", "", text, flags=re.MULTILINE)
    # Remove excessive dots (ellipsis is ok, 5+ is noise)
    text = re.sub(r"\.{5,}", "...", text)
    return text.strip()


def split_text_for_tts(text: str, max_chars: int = 9000) -> list[str]:
    """Split long text at sentence boundaries for TTS chunking."""
    if len(text) <= max_chars:
        return [text]

    chunks = []
    # Split at Vietnamese/general sentence endings
    sentences = re.split(r"(?<=[.!?。！？])\s+", text)

    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= max_chars:
            current = (current + " " + sentence).strip()
        else:
            if current:
                chunks.append(current)
            # Handle sentences longer than max_chars by splitting at commas
            if len(sentence) > max_chars:
                parts = re.split(r"(?<=[,،،،])\s+", sentence)
                for part in parts:
                    if len(current) + len(part) + 1 <= max_chars:
                        current = (current + " " + part).strip()
                    else:
                        if current:
                            chunks.append(current)
                        current = part
            else:
                current = sentence

    if current:
        chunks.append(current)

    return chunks
