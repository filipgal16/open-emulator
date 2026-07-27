; Tiny real-mode guest for open-emulator VMM.
; Assembled offsets are ORG 0; the VMM loads the image at GPA 0x1000
; and starts with CS.base=0x1000, IP=0.

BITS 16
ORG 0

start:
    mov dx, 0x3f8
    mov si, message

.print:
    mov al, [si]
    test al, al
    jz .done
    out dx, al
    inc si
    jmp .print

.done:
    hlt
    jmp .done

message:
    db "open-emulator: guest is alive", 13, 10, 0
