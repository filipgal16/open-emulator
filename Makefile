CC       ?= gcc
CFLAGS   ?= -O2 -Wall -Wextra -Werror -std=c11 -Iinclude
LDFLAGS  ?=

BUILD    := build
BIN      := $(BUILD)/open-vmm
GUEST    := $(BUILD)/guest/hello.bin
TEST_LONG := $(BUILD)/test_long_virtio

SRC      := src/main.c src/vmm.c src/serial.c src/x86_soft.c src/x86_long.c src/virtio_mmio.c
OBJ      := $(patsubst src/%.c,$(BUILD)/%.o,$(SRC))
CORE_OBJ := $(filter-out $(BUILD)/main.o,$(OBJ))

.PHONY: all clean test test-long run guest \
	android-fetch android-setup android-run android \
	android-provision android-start android-stop android-status android-doctor android-bench \
	desktop-server

all: $(BIN) $(GUEST)

android-fetch:
	./android/scripts/fetch_android.sh

android-setup:
	./android/scripts/setup_avd.sh

android-provision:
	ANDROID_HEADLESS=1 ./android/bin/open-emu start --cold
	ANDROID_HEADLESS=1 ./android/bin/open-emu provision

android-start:
	ANDROID_HEADLESS=1 ./android/bin/open-emu start

android-stop:
	./android/bin/open-emu stop

android-status:
	./android/bin/open-emu status

android-doctor:
	./android/bin/open-emu doctor

android-run:
	ANDROID_HEADLESS=1 ./android/bin/open-emu demo

android-bench:
	ANDROID_HEADLESS=1 ./android/scripts/bench_realtime.sh

android: android-fetch android-setup android-provision android-start

desktop-server:
	cd desktop && npm install && npm run server

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

test-long: $(TEST_LONG)
	@./$(TEST_LONG)

$(TEST_LONG): tests/test_long_virtio.c $(CORE_OBJ) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $< $(CORE_OBJ) $(LDFLAGS)

clean:
	rm -rf $(BUILD)
