#!/usr/bin/env python3
"""Assemble the hello guest into a flat 16-bit binary (no NASM required).

Binary is loaded by the VMM at GPA 0x1000 with CS.base=0x1000 / IP=0,
so label offsets inside the image are ORG 0 relative.
"""

from __future__ import annotations

import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "guest" / "hello.bin"

MESSAGE = b"open-emulator: guest is alive\r\n\0"


def assemble() -> bytes:
    code = bytearray()

    def here() -> int:
        return len(code)

    # mov dx, 0x3f8
    code += b"\xba" + struct.pack("<H", 0x3F8)

    # mov si, message
    mov_si_imm_at = len(code)
    code += b"\xbe" + b"\x00\x00"

    print_label = here()

    # mov al, [si]
    code += b"\x8a\x04"

    # test al, al
    code += b"\x84\xc0"

    # jz .done
    jz_at = len(code)
    code += b"\x74\x00"

    # out dx, al
    code += b"\xee"

    # inc si
    code += b"\x46"

    # jmp .print
    jmp_print_at = len(code)
    code += b"\xeb\x00"

    done_label = here()

    # hlt
    code += b"\xf4"

    # jmp .done
    jmp_done_at = len(code)
    code += b"\xeb\x00"

    message_off = here()
    code += MESSAGE

    code[mov_si_imm_at + 1 : mov_si_imm_at + 3] = struct.pack("<H", message_off)

    code[jz_at + 1] = (done_label - (jz_at + 2)) & 0xFF
    code[jmp_print_at + 1] = (print_label - (jmp_print_at + 2)) & 0xFF
    code[jmp_done_at + 1] = (done_label - (jmp_done_at + 2)) & 0xFF

    return bytes(code)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    blob = assemble()
    OUT.write_bytes(blob)
    print(f"wrote {OUT} ({len(blob)} bytes)")


if __name__ == "__main__":
    main()
