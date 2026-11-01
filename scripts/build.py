"""Build a reproducible XPI using only the Python standard library."""

from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo


root = Path(__file__).resolve().parent.parent
source = root / "addon"
output = root / "dist" / "zotero-pdf-deduplicator.xpi"
output.parent.mkdir(parents=True, exist_ok=True)

with ZipFile(output, "w", compression=ZIP_STORED) as archive:
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        info = ZipInfo(path.relative_to(source).as_posix(), (2020, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())

print(output)
