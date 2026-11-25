# Third-party notices

This lists the Rust crates that open-emulator and its tools are built from. It was generated from
`cargo metadata --format-version 1`: every package in the dependency graph that is not part of this
workspace, with the version in `Cargo.lock` and the `license` field its authors declared, grouped by
licence expression and sorted by name. It covers the crates compiled into the app and the developer
tools (`xtask`, `open-vmm`), including crates only used on other platforms or for building; the
installer itself contains only what the app links. Regenerate it whenever `Cargo.lock` changes.

Where a crate offers a choice (`MIT OR Apache-2.0`), open-emulator uses it under whichever of the
options permits the use. The full licence texts are in each crate's own source package.

Android itself, the emulator and the system images are not Rust crates and are not listed here; see
[`LICENSING.md`](LICENSING.md).

The one font built into the app, Inter, is listed at the end, with its licence in full, as that
licence asks.

Total: 582 crates, 33 distinct licence expressions.

## Summary

| Licence | Crates |
|---|---|
| MIT OR Apache-2.0 | 252 |
| MIT | 132 |
| Apache-2.0 OR MIT | 64 |
| MIT/Apache-2.0 | 25 |
| Unicode-3.0 | 18 |
| Apache-2.0 | 11 |
| MIT OR Apache-2.0 OR Zlib | 10 |
| Zlib OR Apache-2.0 OR MIT | 9 |
| BSD-3-Clause | 8 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 7 |
| BSD-2-Clause | 6 |
| Unlicense OR MIT | 4 |
| Zlib | 4 |
| ISC | 3 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 2 |
| Apache-2.0 OR ISC OR MIT | 2 |
| Apache-2.0/MIT | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 |
| BSL-1.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| MIT OR Zlib OR Apache-2.0 | 2 |
| Unlicense/MIT | 2 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| (MIT OR Apache-2.0) AND NCSA | 1 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| Apache-2.0 / MIT | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 AND MIT | 1 |
| Apache-2.0 OR GPL-2.0-only | 1 |
| CC0-1.0 | 1 |
| CC0-1.0 OR Apache-2.0 | 1 |

## MIT OR Apache-2.0

- aead 0.5.2
- aes 0.8.4
- aligned 0.4.3
- android-activity 0.6.1
- android_system_properties 0.1.6
- anyhow 1.0.105
- arbitrary 1.5.0
- arrayvec 0.7.8
- as-slice 0.2.1
- ash 0.38.0+1.3.281
- async-broadcast 0.7.2
- async-recursion 1.2.0
- async-trait 0.1.92
- base64 0.22.1
- base64 0.23.1
- bit_field 0.10.4
- bitflags 2.13.2
- block-buffer 0.12.1
- bumpalo 3.20.4
- cc 1.11.3
- cfg-if 1.0.5
- cipher 0.4.4
- core-foundation 0.10.1
- core-foundation 0.9.4
- core-foundation-sys 0.8.7
- core-graphics 0.23.2
- core-graphics-types 0.1.3
- core-graphics-types 0.2.0
- cosmic-text 0.15.0
- cpubits 0.1.1
- cpufeatures 0.2.17
- cpufeatures 0.3.1
- crc32fast 1.5.5
- crossbeam-deque 0.8.8
- crossbeam-epoch 0.9.21
- crossbeam-utils 0.8.23
- crypto-common 0.1.7
- crypto-common 0.2.2
- ctr 0.9.2
- data-url 0.3.2
- digest 0.11.3
- displaydoc 0.2.7
- document-features 0.2.12
- either 1.19.0
- enumflags2 0.7.12
- enumflags2_derive 0.7.12
- errno 0.3.15
- euclid 0.22.14
- fdeflate 0.3.7
- find-msvc-tools 0.1.15
- flate2 1.1.11
- font-types 0.10.1
- font-types 0.12.7
- form_urlencoded 1.2.3
- futures 0.3.34
- futures-channel 0.3.34
- futures-core 0.3.34
- futures-executor 0.3.34
- futures-io 0.3.34
- futures-macro 0.3.34
- futures-sink 0.3.34
- futures-task 0.3.34
- futures-util 0.3.34
- getrandom 0.2.17
- getrandom 0.3.4
- getrandom 0.4.3
- gif 0.13.3
- gif 0.14.2
- glam 0.25.0
- gpu-alloc 0.6.2
- gpu-alloc-types 0.3.1
- gpu-allocator 0.27.0
- gpu-descriptor 0.3.2
- gpu-descriptor-types 0.2.0
- half 2.7.1
- hashbrown 0.15.5
- hashbrown 0.16.1
- hashbrown 0.17.2
- hermit-abi 0.5.3
- hex 0.4.3
- hmac 0.13.0
- http 1.5.0
- httparse 1.10.1
- hybrid-array 0.4.15
- idna 1.1.0
- image 0.25.10
- image-webp 0.2.4
- inout 0.1.4
- ipnet 2.12.2
- itertools 0.14.0
- itoa 1.0.19
- jni 0.22.4
- jni-macros 0.22.4
- jni-sys 0.3.1
- jni-sys 0.4.1
- jni-sys-macros 0.4.1
- jobserver 0.1.35
- js-sys 0.3.107
- kurbo 0.10.4
- libc 0.2.191
- litrs 1.0.1
- lock_api 0.4.14
- log 0.4.35
- lyon 1.0.19
- lyon_algorithms 1.0.22
- lyon_geom 1.0.20
- lyon_path 1.0.19
- lyon_tessellation 1.0.23
- memmap2 0.9.12
- metal 0.32.0
- mime 0.3.18
- multiversion 0.8.1
- multiversion-macros 0.8.1
- naga 27.0.3
- native-tls 0.2.18
- ndk 0.9.0
- ndk-context 0.1.1
- ndk-sys 0.6.0+11769913
- num-bigint 0.4.8
- num-bigint 0.5.1
- num-derive 0.4.2
- num-integer 0.1.47
- num-rational 0.4.2
- num-traits 0.2.19
- once_cell 1.21.4
- opaque-debug 0.3.1
- openssl-probe 0.2.2
- ordered-stream 0.2.0
- parking_lot 0.12.5
- parking_lot_core 0.9.12
- paste 1.0.15
- pastey 0.1.1
- percent-encoding 2.3.2
- piper 0.2.5
- pkg-config 0.3.34
- png 0.17.16
- png 0.18.1
- ppv-lite86 0.2.21
- presser 0.3.1
- proc-macro-crate 3.5.0
- proc-macro2 1.0.107
- profiling 1.0.18
- profiling-procmacros 1.0.18
- quote 1.0.47
- rand 0.9.5
- rand_chacha 0.9.0
- rand_core 0.10.1
- rand_core 0.9.5
- range-alloc 0.1.5
- rayon 1.12.0
- rayon-core 1.13.0
- read-fonts 0.35.0
- read-fonts 0.41.0
- renderdoc-sys 1.1.0
- reqwest 0.13.5
- roxmltree 0.20.0
- rsa 0.10.0
- rustc_version 0.4.1
- rustls-pki-types 1.16.0
- rustversion 1.0.23
- scopeguard 1.2.0
- security-framework 3.7.0
- security-framework-sys 2.17.0
- semver 1.0.28
- serde 1.0.229
- serde_core 1.0.229
- serde_derive 1.0.229
- serde_json 1.0.154
- serde_repr 0.1.21
- sha1 0.11.0
- sha2 0.11.1
- shlex 2.0.1
- signal-hook-registry 1.4.8
- simdutf8 0.1.5
- siphasher 1.0.4
- skrifa 0.37.0
- skrifa 0.44.0
- smallvec 1.16.6
- smol_str 0.2.2
- socket2 0.6.5
- softbuffer 0.4.8
- stable_deref_trait 1.2.1
- static_assertions 1.1.0
- syn 2.0.119
- syn 3.0.10
- sys-locale 0.3.2
- system-configuration 0.7.0
- system-configuration-sys 0.6.0
- target-features 0.1.6
- tempfile 3.27.0
- thiserror 1.0.69
- thiserror 2.0.21
- thiserror-impl 1.0.69
- thiserror-impl 2.0.21
- tokio-rustls 0.26.6
- toml_datetime 1.1.3+spec-1.1.0
- toml_edit 0.25.20+spec-1.1.0
- toml_parser 1.1.6+spec-1.1.0
- ttf-parser 0.25.1
- typenum 1.20.1
- unicode-bidi 0.3.18
- unicode-script 0.5.9
- unicode-segmentation 1.13.3
- unicode-width 0.2.3
- universal-hash 0.5.1
- url 2.5.9
- wasm-bindgen 0.2.130
- wasm-bindgen-futures 0.4.80
- wasm-bindgen-macro 0.2.130
- wasm-bindgen-macro-support 0.2.130
- wasm-bindgen-shared 0.2.130
- web-sys 0.3.107
- web-time 1.1.0
- weezl 0.1.12
- wgpu 27.0.1
- wgpu-core 27.0.3
- wgpu-core-deps-apple 27.0.0
- wgpu-core-deps-emscripten 27.0.0
- wgpu-core-deps-windows-linux-android 27.0.0
- wgpu-hal 27.0.4
- wgpu-types 27.0.1
- windows 0.58.0
- windows 0.62.2
- windows-collections 0.3.2
- windows-core 0.58.0
- windows-core 0.62.2
- windows-future 0.3.2
- windows-implement 0.58.0
- windows-implement 0.60.2
- windows-interface 0.58.0
- windows-interface 0.59.3
- windows-link 0.2.1
- windows-numerics 0.3.1
- windows-registry 0.6.1
- windows-result 0.2.0
- windows-result 0.4.1
- windows-strings 0.1.0
- windows-strings 0.5.1
- windows-sys 0.52.0
- windows-sys 0.59.0
- windows-sys 0.61.2
- windows-targets 0.52.6
- windows-threading 0.2.1
- windows_aarch64_gnullvm 0.52.6
- windows_aarch64_msvc 0.52.6
- windows_i686_gnu 0.52.6
- windows_i686_gnullvm 0.52.6
- windows_i686_msvc 0.52.6
- windows_x86_64_gnu 0.52.6
- windows_x86_64_gnullvm 0.52.6
- windows_x86_64_msvc 0.52.6
- wmi 0.18.4

## MIT

- aligned-vec 0.6.4
- android-properties 0.2.2
- arg_enum_proc_macro 0.3.4
- ashpd 0.11.1
- av-scenechange 0.14.1
- block 0.1.6
- block2 0.5.1
- block2 0.6.2
- built 0.8.1
- bytes 1.12.2
- calloop 0.13.0
- cfg_aliases 0.2.2
- color_quant 1.1.0
- combine 4.6.9
- core_maths 0.1.1
- crunchy 0.2.4
- dispatch 0.2.0
- dlib 0.5.3
- endi 1.1.1
- equator 0.4.2
- equator-macro 0.4.2
- fax 0.2.7
- float-cmp 0.9.0
- float_next_after 1.0.0
- fontconfig-parser 0.5.8
- fontdb 0.23.0
- generic-array 0.14.7
- h2 0.4.20
- harfrust 0.3.2
- http-body 1.1.0
- http-body-util 0.1.5
- hyper 1.12.0
- hyper-util 0.1.21
- iced 0.14.0
- iced_core 0.14.0
- iced_debug 0.14.0
- iced_futures 0.14.0
- iced_graphics 0.14.0
- iced_program 0.14.0
- iced_renderer 0.14.0
- iced_runtime 0.14.0
- iced_tiny_skia 0.14.1
- iced_wgpu 0.14.0
- iced_widget 0.14.2
- iced_winit 0.14.1
- imagesize 0.13.0
- interpolate_name 0.2.4
- libm 0.2.16
- libredox 0.1.25
- lilt 0.8.2
- loop9 0.1.5
- lru 0.16.4
- malloc_buf 0.0.6
- maybe-rayon 0.1.1
- memoffset 0.9.1
- mio 1.2.5
- new_debug_unreachable 1.0.6
- nom 8.0.0
- noop_proc_macro 0.3.0
- objc 0.2.7
- objc-sys 0.3.5
- objc2 0.5.3
- objc2 0.6.5
- objc2-app-kit 0.2.2
- objc2-cloud-kit 0.2.2
- objc2-contacts 0.2.2
- objc2-core-data 0.2.2
- objc2-core-image 0.2.2
- objc2-core-location 0.2.2
- objc2-encode 4.1.0
- objc2-foundation 0.2.2
- objc2-foundation 0.3.2
- objc2-link-presentation 0.2.2
- objc2-metal 0.2.2
- objc2-quartz-core 0.2.2
- objc2-symbols 0.2.2
- objc2-ui-kit 0.2.2
- objc2-uniform-type-identifiers 0.2.2
- objc2-user-notifications 0.2.2
- openssl-sys 0.9.118
- orbclient 0.3.55
- ordered-float 5.5.1
- pico-args 0.5.0
- quick-xml 0.41.0
- redox_syscall 0.4.1
- redox_syscall 0.5.18
- redox_syscall 0.9.5
- rfd 0.15.4
- rgb 0.8.53
- rustybuzz 0.20.1
- schannel 0.1.30
- simd-adler32 0.3.10
- simd_helpers 0.1.0
- slab 0.4.12
- strict-num 0.1.1
- synstructure 0.14.0
- tiff 0.11.3
- tokio 1.54.1
- tokio-macros 2.7.2
- tokio-native-tls 0.3.1
- tokio-util 0.7.20
- tower 0.5.3
- tower-http 0.6.11
- tower-layer 0.3.3
- tower-service 0.3.3
- tracing 0.1.44
- tracing-attributes 0.1.31
- tracing-core 0.1.36
- try-lock 0.2.5
- uds_windows 1.2.1
- urlencoding 2.1.3
- want 0.3.2
- wasmtimer 0.4.5
- wayland-backend 0.3.17
- wayland-client 0.31.15
- wayland-protocols 0.32.13
- wayland-scanner 0.31.11
- wayland-sys 0.31.11
- window_clipboard 0.5.1
- winnow 1.0.5
- xkbcommon-dl 0.4.2
- xml-rs 0.8.29
- xmlwriter 0.1.0
- y4m 0.8.0
- zbus 5.19.0
- zbus_macros 5.19.0
- zbus_names 4.3.5
- zcheapstr 1.4.0
- zmij 1.0.23
- zvariant 5.15.1
- zvariant_derive 5.15.1
- zvariant_utils 4.2.0

## Apache-2.0 OR MIT

- aes-gcm 0.10.3
- async-channel 2.5.0
- async-executor 1.14.1
- async-fs 2.2.0
- async-io 2.6.0
- async-lock 3.5.0
- async-net 2.0.0
- async-process 2.5.0
- async-signal 0.2.14
- async-task 4.7.1
- atomic-waker 1.1.2
- autocfg 1.5.1
- base16ct 1.0.0
- base64ct 1.8.3
- bit-set 0.8.0
- bit-vec 0.8.0
- blocking 1.7.0
- cmov 0.5.4
- concurrent-queue 2.5.0
- const-oid 0.10.3
- crypto-bigint 0.7.11
- crypto-primes 0.7.2
- ctutils 0.4.8
- der 0.8.3
- equivalent 1.0.3
- event-listener 5.4.2
- event-listener-strategy 0.5.4
- fastrand 2.5.0
- futures-lite 2.6.1
- ghash 0.5.1
- idna_adapter 1.2.2
- indexmap 2.14.2
- kurbo 0.11.3
- kvm-ioctls 0.22.1
- linebender_resource_handle 0.1.1
- multiversion_no_op 1.0.0
- no_std_io2 0.9.4
- parking 2.2.1
- pem-rfc7468 1.0.0
- pin-project 1.2.0
- pin-project-internal 1.2.0
- pin-project-lite 0.2.18
- pkcs1 0.8.0
- pkcs8 0.11.0
- polling 3.11.0
- polyval 0.6.2
- portable-atomic 1.15.0
- portable-atomic-util 0.2.8
- resvg 0.45.1
- rustc-hash 2.1.3
- serdect 0.4.3
- signature 3.0.0
- simd_cesu8 1.2.0
- simplecss 0.2.2
- spki 0.8.1
- svgtypes 0.15.3
- swash 0.2.10
- usvg 0.45.1
- utf8_iter 1.1.0
- utf_types 1.0.0
- uuid 1.29.3
- yazi 0.2.2
- zeno 0.3.3
- zeroize 1.9.2

## MIT/Apache-2.0

- bitflags 1.3.2
- bitstream-io 4.10.0
- core_detect 1.0.0
- downcast-rs 1.2.1
- etagere 0.2.15
- foreign-types 0.3.2
- foreign-types 0.5.0
- foreign-types-macros 0.2.4
- foreign-types-shared 0.1.1
- foreign-types-shared 0.3.1
- guillotiere 0.6.2
- hyper-tls 0.6.0
- khronos-egl 6.0.0
- openssl-macros 0.1.1
- plain 0.2.3
- qoi 0.4.1
- quick-error 2.0.1
- rangemap 1.8.0
- scoped-tls 1.0.1
- svg_fmt 0.4.5
- unicode-bidi-mirroring 0.4.0
- unicode-ccc 0.4.0
- unicode-vo 0.1.0
- vcpkg 0.2.15
- version_check 0.9.5

## Unicode-3.0

- icu_collections 2.4.0
- icu_locale_core 2.4.0
- icu_normalizer 2.4.0
- icu_normalizer_data 2.4.0
- icu_properties 2.4.0
- icu_properties_data 2.4.0
- icu_provider 2.4.0
- litemap 0.8.3
- potential_utf 0.1.6
- tinystr 0.8.5
- writeable 0.6.4
- yoke 0.8.4
- yoke-derive 0.8.4
- zerofrom 0.1.8
- zerofrom-derive 0.1.8
- zerotrie 0.2.5
- zerovec 0.11.9
- zerovec-derive 0.11.7

## Apache-2.0

- clipboard_macos 0.1.1
- codespan-reporting 0.12.0
- gl_generator 0.14.0
- glutin_wgl_sys 0.6.1
- khronos_api 3.1.0
- kvm-bindings 0.12.1
- openssl 0.10.82
- spirv 0.3.0+sdk-1.3.268.0
- sync_wrapper 1.0.2
- unicode-linebreak 0.1.5
- winit 0.30.13

## MIT OR Apache-2.0 OR Zlib

- cryoglyph 0.1.0
- cursor-icon 1.2.0
- glow 0.16.0
- raw-window-handle 0.6.2
- xkeysym 0.2.1
- zune-core 0.4.12
- zune-core 0.5.3
- zune-inflate 0.2.54
- zune-jpeg 0.4.21
- zune-jpeg 0.5.15

## Zlib OR Apache-2.0 OR MIT

- bytemuck 1.25.2
- bytemuck_derive 1.12.1
- dispatch2 0.3.1
- objc2-app-kit 0.3.2
- objc2-core-foundation 0.3.2
- objc2-core-graphics 0.3.2
- objc2-io-surface 0.3.2
- objc2-quartz-core 0.3.2
- tinyvec 1.13.3

## BSD-3-Clause

- avif-serialize 0.8.9
- exr 1.74.3
- lebe 0.5.3
- ravif 0.13.0
- subtle 2.6.1
- tiny-skia 0.11.4
- tiny-skia-path 0.11.4
- vmm-sys-util 0.14.0

## Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT

- linux-raw-sys 0.12.1
- linux-raw-sys 0.4.15
- rustix 0.38.44
- rustix 1.1.6
- wasi 0.11.1+wasi-snapshot-preview1
- wasip2 1.0.4+wasi-0.2.12
- wit-bindgen 0.57.1

## BSD-2-Clause

- arrayref 0.3.9
- av1-grain 0.2.5
- kamadak-exif 0.6.2
- mutate_once 0.1.2
- rav1e 0.8.1
- v_frame 0.3.9

## Unlicense OR MIT

- byteorder-lite 0.1.0
- memchr 2.8.3
- termcolor 1.4.1
- winapi-util 0.1.11

## Zlib

- foldhash 0.1.5
- foldhash 0.2.0
- slotmap 1.1.1
- zlib-rs 0.6.8

## ISC

- libloading 0.8.9
- rustls-webpki 0.103.17
- untrusted 0.9.0

## (MIT OR Apache-2.0) AND Unicode-3.0

- unicode-ident 1.0.27
- unicode-properties 0.1.5

## Apache-2.0 OR ISC OR MIT

- hyper-rustls 0.27.10
- rustls 0.23.46

## Apache-2.0/MIT

- pollster 0.4.0
- rustc-hash 1.1.0

## BSD-2-Clause OR Apache-2.0 OR MIT

- zerocopy 0.8.64
- zerocopy-derive 0.8.64

## BSD-3-Clause OR Apache-2.0

- moxcms 0.8.1
- pxfm 0.1.30

## BSD-3-Clause OR MIT OR Apache-2.0

- num_enum 0.7.6
- num_enum_derive 0.7.6

## BSL-1.0

- clipboard-win 5.4.3
- error-code 3.4.0

## MIT OR Apache-2.0 OR LGPL-2.1-or-later

- r-efi 5.3.0
- r-efi 6.0.0

## MIT OR Zlib OR Apache-2.0

- miniz_oxide 0.8.9
- miniz_oxide 0.9.1

## Unlicense/MIT

- same-file 1.0.6
- walkdir 2.5.1

## (Apache-2.0 OR MIT) AND BSD-3-Clause

- encoding_rs 0.8.44

## (MIT OR Apache-2.0) AND NCSA

- libfuzzer-sys 0.4.13

## 0BSD OR MIT OR Apache-2.0

- adler2 2.0.1

## Apache-2.0 / MIT

- fnv 1.0.7

## Apache-2.0 AND ISC

- ring 0.17.14

## Apache-2.0 AND MIT

- dpi 0.1.2

## Apache-2.0 OR GPL-2.0-only

- self_cell 1.3.0

## CC0-1.0

- hexf-parse 0.2.1

## CC0-1.0 OR Apache-2.0

- imgref 1.12.3

## Fonts

### Inter 4.001

Built into the app as `crates/oe-ui/assets/fonts/Inter-Regular.ttf`, `Inter-Medium.ttf` and
`Inter-SemiBold.ttf`, the static instances Google Fonts serves (https://fonts.google.com/specimen/Inter).

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

Licensed under the SIL Open Font License, Version 1.1:

```text
SIL OPEN FONT LICENSE

Version 1.1 - 26 February 2007

PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS

"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting — in part or in whole — any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION

This license becomes null and void if any of the above conditions are not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
```
