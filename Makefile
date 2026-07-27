CC       ?= gcc
CFLAGS   ?= -O2 -Wall -Wextra -Werror -std=c11 -Iinclude
LDFLAGS  ?=

BUILD    := build
BIN      := $(BUILD)/open-vmm
GUEST    := $(BUILD)/guest/hello.bin

SRC      := src/main.c src/vmm.c src/serial.c src/x86_soft.c
OBJ      := $(patsubst src/%.c,$(BUILD)/%.o,$(SRC))

.PHONY: all clean test run guest

all: $(BIN) $(GUEST)

$(BIN): $(OBJ) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(LDFLAGS)

$(BUILD)/%.o: src/%.c include/*.h | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(GUEST): scripts/assemble_guest.py guest/hello.asm | $(BUILD)/guest
	python3 scripts/assemble_guest.py

$(BUILD) $(BUILD)/guest:
	mkdir -p $@

run: all
	./$(BIN) --backend=soft $(GUEST)

test: all
	@./scripts/smoke_test.sh

clean:
	rm -rf $(BUILD)
