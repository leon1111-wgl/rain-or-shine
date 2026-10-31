"""Build-time archive helper for the desktop packages. The receiving computer does not need Python."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import struct
import tarfile
import zipfile


def runtime(archive, prefix, output, arch):
    # Extract two named regular files only; never unpack arbitrary archive paths.
    output.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        for source_name, destination, maximum in [("bin/node", "node", 250_000_000), ("LICENSE", "LICENSE", 5_000_000)]:
            member = source.getmember(prefix + "/" + source_name)
            if not member.isfile() or member.size <= 0 or member.size > maximum:
                raise ValueError("Unexpected runtime archive member: " + source_name)
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("Runtime member could not be read")
            with stream:
                data = stream.read(maximum + 1)
            if len(data) != member.size:
                raise ValueError("Runtime member size mismatch")
            if destination == "node":
                magic, cpu = struct.unpack("<II", data[:8])
                expected_cpu = {"arm64": 0x0100000C, "x64": 0x01000007}[arch]
                if magic != 0xFEEDFACF or cpu != expected_cpu:
                    raise ValueError("Runtime is not the expected 64-bit Mach-O architecture")
            target = output / destination
            if target.exists():
                if target.is_symlink() or target.read_bytes() != data:
                    raise ValueError("Existing runtime differs: " + str(target))
            else:
                with target.open("xb") as handle:
                    handle.write(data)
            target.chmod(0o755 if destination == "node" else 0o644)


def windows_runtime(archive, prefix, output):
    # Extract two named regular files only; never unpack arbitrary archive paths.
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for source_name, destination, maximum in [("node.exe", "node.exe", 250_000_000), ("LICENSE", "LICENSE", 5_000_000)]:
            info = source.getinfo(prefix + "/" + source_name)
            if info.is_dir() or info.file_size <= 0 or info.file_size > maximum:
                raise ValueError("Unexpected runtime archive member: " + source_name)
            data = source.read(info)
            if destination == "node.exe":
                pe = struct.unpack("<I", data[0x3C:0x40])[0]
                if data[:2] != b"MZ" or data[pe:pe + 4] != b"PE\0\0" or struct.unpack("<H", data[pe + 4:pe + 6])[0] != 0x8664:
                    raise ValueError("Runtime is not a 64-bit x64 Windows executable")
            target = output / destination
            if target.exists():
                if target.is_symlink() or target.read_bytes() != data:
                    raise ValueError("Existing runtime differs: " + str(target))
            else:
                with target.open("xb") as handle:
                    handle.write(data)


def archive_zip(root, destination):
    # Explicit Unix permission bits are needed when creating macOS ZIPs on Windows.
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Package root must be a real directory")
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(root.rglob("*")):
            if file.is_symlink():
                raise ValueError("Package cannot contain symlinks")
            if not file.is_file():
                continue
            relative = file.relative_to(root).as_posix()
            executable = relative in {"START-MAC.command", "GET-WEATHER.command", "app/runtime/node", "app/launcher/mac-common.sh"}
            data = file.read_bytes()
            if relative.endswith((".command", ".sh")) and (b"\r" in data or not data.startswith(b"#!/bin/bash\n")):
                raise ValueError("Mac shell scripts must have an LF shebang: " + relative)
            if relative.endswith(".cmd") and data.count(b"\n") != data.count(b"\r\n"):
                raise ValueError("Windows scripts must use CRLF line endings: " + relative)
            info = zipfile.ZipInfo(root.name + "/" + relative)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=6)
    with zipfile.ZipFile(destination) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise ValueError("ZIP CRC mismatch: " + bad)
        manifest = json.loads(archive.read(root.name + "/app/manifest.json"))
        listed = {root.name + "/" + entry["path"] for entry in manifest["files"]}
        if set(archive.namelist()) != listed | {root.name + "/app/manifest.json"}:
            raise ValueError("ZIP file inventory does not match manifest")
        for entry in manifest["files"]:
            data = archive.read(root.name + "/" + entry["path"])
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("ZIP checksum mismatch: " + entry["path"])
        names = set(archive.namelist())
        for name in ("START-MAC.command", "GET-WEATHER.command", "app/runtime/node"):
            if root.name + "/" + name not in names:
                continue
            if (archive.getinfo(root.name + "/" + name).external_attr >> 16) & 0o777 != 0o755:
                raise ValueError("Missing executable permissions: " + name)
    print(json.dumps({"zip": str(destination), "files": len(listed) + 1, "crcAndManifest": "PASS", "unixExecutablePermissions": "PASS"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    extract = sub.add_parser("runtime")
    extract.add_argument("archive", type=Path)
    extract.add_argument("prefix")
    extract.add_argument("output", type=Path)
    extract.add_argument("arch", choices=("arm64", "x64"))
    windows = sub.add_parser("runtime-windows")
    windows.add_argument("archive", type=Path)
    windows.add_argument("prefix")
    windows.add_argument("output", type=Path)
    create = sub.add_parser("zip")
    create.add_argument("root", type=Path)
    create.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "runtime":
        runtime(args.archive, args.prefix, args.output, args.arch)
    elif args.command == "runtime-windows":
        windows_runtime(args.archive, args.prefix, args.output)
    else:
        archive_zip(args.root, args.destination)
