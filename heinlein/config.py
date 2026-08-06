"""Load and merge heinlein.yaml project config with built-in defaults."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ALL_FORMATS = ("pdf", "epub", "docx", "html", "text")
SOURCE_FORMATS = ("markdown", "twine1")

PAGE_SIZES = {
    "digest": (5.5, 8.5),
    "trade":  (6.0, 9.0),
    "mass":   (4.25, 6.87),
}


_UNIT_TO_IN = {"in": 1.0, "mm": 1.0 / 25.4, "cm": 1.0 / 2.54, "pt": 1.0 / 72.0}


def _length_to_in(value: str) -> float:
    """Parse a CSS-like length (e.g. '0.125in', '3mm', '0') into inches."""
    s = str(value).strip().lower()
    if not s or s in {"0", "0in", "0mm", "0cm", "0pt"}:
        return 0.0
    for unit, factor in _UNIT_TO_IN.items():
        if s.endswith(unit):
            return float(s[: -len(unit)]) * factor
    # Bare number — assume inches.
    return float(s)


@dataclass
class PageConfig:
    size: str = "digest"
    margin_top: str = "0.85in"
    margin_side: str = "0.7in"
    bleed: str = "0in"

    @property
    def width_in(self) -> float:
        return PAGE_SIZES[self.size][0]

    @property
    def height_in(self) -> float:
        return PAGE_SIZES[self.size][1]

    @property
    def bleed_in(self) -> float:
        return _length_to_in(self.bleed)


@dataclass
class HeinleinConfig:
    manuscript: Path
    cover: Path | None = None
    imprint: str = "free-play"
    page: PageConfig = field(default_factory=PageConfig)
    metadata: dict[str, Any] = field(default_factory=dict)
    formats: tuple[str, ...] = ALL_FORMATS
    output: Path = Path("dist")
    archive: Path | None = None
    accents: dict[str, str] = field(default_factory=dict)
    chapters: bool = False
    source_format: str = "markdown"
    twine_start: str = "Start"
    twine_exclude: tuple[str, ...] = ()
    twine_restart_label: str = "Start over"
    twine_back_label: str = "Back"

    @property
    def project_dir(self) -> Path:
        return self.manuscript.parent


def _coerce_page(raw: dict[str, Any]) -> PageConfig:
    p = PageConfig()
    if "size" in raw:
        if raw["size"] not in PAGE_SIZES:
            raise ValueError(f"Unknown page size: {raw['size']}. Valid: {list(PAGE_SIZES)}")
        p.size = raw["size"]
    margins = raw.get("margins") or {}
    if "top" in margins:
        p.margin_top = str(margins["top"])
    if "side" in margins:
        p.margin_side = str(margins["side"])
    if "bleed" in raw:
        p.bleed = str(raw["bleed"])
    return p


def _coerce_formats(raw: Any) -> tuple[str, ...]:
    if raw is None or raw == "all":
        return ALL_FORMATS
    if isinstance(raw, str):
        items = [s.strip() for s in raw.split(",") if s.strip()]
    elif isinstance(raw, (list, tuple)):
        items = [str(s).strip() for s in raw]
    else:
        raise ValueError(f"Cannot interpret formats={raw!r}")
    if items == ["all"]:
        return ALL_FORMATS
    for f in items:
        if f not in ALL_FORMATS:
            raise ValueError(f"Unknown format: {f}. Valid: {list(ALL_FORMATS)}")
    return tuple(items)


def load(
    manuscript: Path | None = None,
    project_yaml: Path | None = None,
    output_override: Path | None = None,
    formats_override: Any = None,
    archive_override: Path | None = None,
    source_format_override: str | None = None,
    twine_start_override: str | None = None,
    twine_exclude_override: tuple[str, ...] | None = None,
    twine_restart_label_override: str | None = None,
    twine_back_label_override: str | None = None,
    author_override: str | None = None,
) -> HeinleinConfig:
    """
    Resolve config. Either manuscript or project_yaml must be supplied.

    Project mode: if `project_yaml` points to a heinlein.yaml file, load it.
    Manuscript mode: if only `manuscript` is given, use built-in defaults.

    CLI overrides win over yaml.
    """
    raw: dict[str, Any] = {}
    base_dir = Path.cwd()

    if project_yaml is not None:
        project_yaml = project_yaml.resolve()
        base_dir = project_yaml.parent
        raw = yaml.safe_load(project_yaml.read_text(encoding="utf-8")) or {}

    if manuscript is None:
        if "manuscript" not in raw:
            raise ValueError("heinlein.yaml is missing required 'manuscript:' field")
        manuscript = (base_dir / raw["manuscript"]).resolve()
    else:
        manuscript = manuscript.resolve()

    cover_raw = raw.get("cover")
    cover_path: Path | None = None
    if cover_raw:
        cover_path = (base_dir / cover_raw).resolve()

    page = _coerce_page(raw.get("page") or {})

    formats = _coerce_formats(formats_override if formats_override is not None else raw.get("formats"))

    if output_override is not None:
        output = output_override.resolve()
    elif "output" in raw:
        output = (base_dir / raw["output"]).resolve()
    else:
        output = (base_dir / "dist").resolve()

    archive: Path | None = None
    if archive_override is not None:
        archive = archive_override.resolve()
    elif raw.get("archive"):
        archive = (base_dir / raw["archive"]).resolve()

    accents_raw = raw.get("accents") or {}
    accents = {str(k): str(v) for k, v in accents_raw.items()}

    chapters = bool(raw.get("chapters", False))
    source_format = source_format_override or raw.get("source_format", "markdown")
    if source_format not in SOURCE_FORMATS:
        raise ValueError(f"Unknown source_format={source_format!r}. Valid: {list(SOURCE_FORMATS)}")
    twine = raw.get("twine") or {}
    twine_start = twine_start_override or str(twine.get("start", "Start"))
    raw_exclude = twine_exclude_override if twine_exclude_override is not None else twine.get("exclude", ())
    if isinstance(raw_exclude, str):
        raw_exclude = (raw_exclude,)
    twine_exclude = tuple(str(value) for value in raw_exclude)
    twine_restart_label = twine_restart_label_override or str(twine.get("restart_label", "Start over"))
    twine_back_label = twine_back_label_override or str(twine.get("back_label", "Back"))
    metadata = dict(raw.get("metadata") or {})
    if author_override is not None:
        metadata["author"] = author_override

    return HeinleinConfig(
        manuscript=manuscript,
        cover=cover_path,
        imprint=raw.get("imprint", "free-play"),
        page=page,
        metadata=metadata,
        formats=formats,
        output=output,
        archive=archive,
        accents=accents,
        chapters=chapters,
        source_format=source_format,
        twine_start=twine_start,
        twine_exclude=twine_exclude,
        twine_restart_label=twine_restart_label,
        twine_back_label=twine_back_label,
    )


def discover_project_yaml(start: Path) -> Path | None:
    """Walk up from `start` looking for heinlein.yaml."""
    start = start.resolve()
    for d in [start, *start.parents]:
        candidate = d / "heinlein.yaml"
        if candidate.is_file():
            return candidate
    return None
