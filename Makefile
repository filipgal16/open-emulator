CC       ?= gcc
CFLAGS   ?= -O2 -Wall -Wextra -Werror -std=c11 -Iinclude
LDFLAGS  ?=

BUILD    := build
BIN      := $(BUILD)/open-vmm
GUEST    := $(BUILD)/guest/hello.bin

SRC      := src/main.c src/vmm.c src/serial.c src/x86_soft.c
OBJ      := $(patsubst src/%.c,$(BUILD)/%.o,$(SRC))

.PHONY: all clean test run guest android-fetch android-setup android-run android

all: $(BIN) $(GUEST)

android-fetch:
	./android/scripts/fetch_android.sh

android-setup:
	./android/scripts/setup_avd.sh

android-run:
	./android/scripts/run_android.sh

android: android-fetch android-setup android-run

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
