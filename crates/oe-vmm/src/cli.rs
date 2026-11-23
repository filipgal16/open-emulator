//! The command line of `open-vmm`, behaving like the C program's `main`.
//!
//! It lives in the library so the argument handling can be tested without spawning a process.
//! The option parser accepts what `getopt_long` did: short options with attached or separate
//! values, long options with `=` or a separate value, unambiguous prefixes of long options,
//! options after the guest path, and `--` to end option parsing.

use std::path::Path;

use crate::vmm::{Backend, Vmm, kvm_available};
use crate::GUEST_ENTRY;

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Run { backend: Backend, ram_mib: u64, guest_path: String },
}

/// Why the command line was rejected, and the exit status the C program used for it.
#[derive(Debug, PartialEq, Eq)]
pub enum ArgumentError {
    /// A usage mistake: print the usage text and exit with status 2.
    Usage,
    /// A specific complaint, printed on its own, with exit status 2.
    Message(String),
}

fn usage(program: &str) -> String {
    format!(
        "Usage: {program} [options] <guest.bin>\n\
         \n\
         Minimal Type-2 VMM for open-emulator (step 1: hypervisor).\n\
         \n\
         Options:\n\
         \x20 -b, --backend=auto|kvm|soft   CPU backend (default: auto)\n\
         \x20 -m, --memory=MiB              Guest RAM in MiB (default: 16)\n\
         \x20 -h, --help                    Show this help\n\
         \n\
         The guest is a flat binary loaded at GPA 0x{GUEST_ENTRY:x} and run until HLT.\n\
         Serial output on port 0x3f8 is printed to stdout.\n"
    )
}

fn parse_backend(text: &str) -> Result<Backend, ArgumentError> {
    match text {
        "auto" => Ok(Backend::Auto),
        "kvm" => Ok(Backend::Kvm),
        "soft" => Ok(Backend::Soft),
        other => Err(ArgumentError::Message(format!("unknown backend '{other}'"))),
    }
}

/// Parses a number the way C's `strtoul(text, NULL, 0)` does: leading spaces, an optional sign,
/// a `0x` or `0` prefix for hexadecimal or octal, and trailing garbage ignored. Text with no
/// digits yields zero, which the caller treats as invalid.
fn parse_c_unsigned(text: &str) -> u64 {
    let text = text.trim_start();
    let text = text.strip_prefix('+').unwrap_or(text);
    let (radix, digits) = if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        (16, rest)
    } else if text.starts_with('0') && text.len() > 1 {
        (8, &text[1..])
    } else {
        (10, text)
    };
    let end = digits.find(|c: char| !c.is_digit(radix)).unwrap_or(digits.len());
    u64::from_str_radix(&digits[..end], radix).unwrap_or(if end == 0 { 0 } else { u64::MAX })
}

const LONG_OPTIONS: [(&str, char); 3] = [("backend", 'b'), ("memory", 'm'), ("help", 'h')];

/// Applies one option, with its value if it takes one.
fn apply(
    option: char,
    value: Option<&str>,
    backend: &mut Backend,
    ram_mib: &mut u64,
    help: &mut bool,
) -> Result<(), ArgumentError> {
    match option {
        'b' => *backend = parse_backend(value.ok_or(ArgumentError::Usage)?)?,
        'm' => {
            *ram_mib = parse_c_unsigned(value.ok_or(ArgumentError::Usage)?);
            if *ram_mib == 0 {
                return Err(ArgumentError::Message("memory must be > 0".to_string()));
            }
        }
        _ => *help = true,
    }
    Ok(())
}

/// Parses the arguments after the program name.
pub fn parse_arguments(args: &[String]) -> Result<Command, ArgumentError> {
    let mut backend = Backend::Auto;
    let mut ram_mib = 16;
    // `-h` returns at once, as the C program did: options after it are never examined, while
    // invalid options before it are still reported.
    let mut help = false;
    let mut positional: Vec<&str> = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        index += 1;

        if argument == "--" {
            positional.extend(args[index..].iter().map(String::as_str));
            break;
        } else if let Some(long) = argument.strip_prefix("--") {
            let (name, attached) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (long, None),
            };
            let matches: Vec<char> = LONG_OPTIONS
                .iter()
                .filter(|(full, _)| *full == name || (!name.is_empty() && full.starts_with(name)))
                .map(|&(_, short)| short)
                .collect();
            let exact = LONG_OPTIONS.iter().find(|(full, _)| *full == name).map(|&(_, short)| short);
            let option = match (exact, matches.as_slice()) {
                (Some(short), _) => short,
                (None, [short]) => *short,
                _ => return Err(ArgumentError::Usage),
            };
            let takes_value = option != 'h';
            let value = if !takes_value {
                if attached.is_some() {
                    return Err(ArgumentError::Usage);
                }
                None
            } else if attached.is_some() {
                attached
            } else {
                let next = args.get(index).map(String::as_str);
                index += usize::from(next.is_some());
                next
            };
            apply(option, value, &mut backend, &mut ram_mib, &mut help)?;
            if help {
                return Ok(Command::Help);
            }
        } else if argument.len() > 1 && argument.starts_with('-') {
            // A short option, with its value attached (`-m32`) or in the next argument. Because
            // `-h` ends parsing at once, a cluster like `-hb` never gets past its first letter.
            let option = argument[1..].chars().next().unwrap_or('?');
            match option {
                'h' => return Ok(Command::Help),
                'b' | 'm' => {
                    let rest = &argument[2..];
                    let value = if !rest.is_empty() {
                        Some(rest)
                    } else {
                        let next = args.get(index).map(String::as_str);
                        index += usize::from(next.is_some());
                        next
                    };
                    apply(option, value, &mut backend, &mut ram_mib, &mut help)?;
                }
                _ => return Err(ArgumentError::Usage),
            }
        } else {
            positional.push(argument);
        }
    }

    match positional.first() {
        Some(path) => Ok(Command::Run { backend, ram_mib, guest_path: (*path).to_string() }),
        None => Err(ArgumentError::Usage),
    }
}

/// Runs the program with the arguments after the program name and returns its exit status.
pub fn run(program: &str, args: &[String]) -> i32 {
    let (backend, ram_mib, guest_path) = match parse_arguments(args) {
        Ok(Command::Help) => {
            eprint!("{}", usage(program));
            return 0;
        }
        Ok(Command::Run { backend, ram_mib, guest_path }) => (backend, ram_mib, guest_path),
        Err(ArgumentError::Usage) => {
            eprint!("{}", usage(program));
            return 2;
        }
        Err(ArgumentError::Message(message)) => {
            eprintln!("{message}");
            return 2;
        }
    };

    eprintln!("open-emulator VMM");
    eprintln!("  kvm available: {}", if kvm_available() { "yes" } else { "no" });

    let Some(ram_size) = ram_mib.checked_mul(1024 * 1024).and_then(|bytes| usize::try_from(bytes).ok()) else {
        eprintln!("memory size is too large");
        return 1;
    };
    let mut vmm = match Vmm::new(ram_size, backend, true) {
        Ok(vmm) => vmm,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };

    if let Err(error) = vmm.load_flat_binary(Path::new(&guest_path), GUEST_ENTRY) {
        eprintln!("{error}");
        return 1;
    }

    let result = vmm.run();
    if let Err(error) = &result {
        eprintln!("{error}");
    }
    eprintln!(
        "\nvmm: exited rc={} exit_code={} serial_bytes={}",
        if result.is_ok() { 0 } else { -1 },
        vmm.exit_code,
        vmm.serial.output().len()
    );

    if result.is_err() { 1 } else { vmm.exit_code }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Command, ArgumentError> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse_arguments(&owned)
    }

    fn run_command(backend: Backend, ram_mib: u64, path: &str) -> Command {
        Command::Run { backend, ram_mib, guest_path: path.to_string() }
    }

    #[test]
    fn defaults() {
        assert_eq!(parse(&["g.bin"]), Ok(run_command(Backend::Auto, 16, "g.bin")));
    }

    #[test]
    fn long_and_short_forms() {
        let expected = Ok(run_command(Backend::Soft, 32, "g.bin"));
        assert_eq!(parse(&["--backend=soft", "--memory=32", "g.bin"]), expected);
        assert_eq!(parse(&["--backend", "soft", "--memory", "32", "g.bin"]), expected);
        assert_eq!(parse(&["-b", "soft", "-m32", "g.bin"]), expected);
        assert_eq!(parse(&["g.bin", "-bsoft", "-m", "0x20"]), expected);
        assert_eq!(parse(&["--back=soft", "--mem=32", "--", "g.bin"]), expected);
    }

    #[test]
    fn help_wins() {
        assert_eq!(parse(&["-h"]), Ok(Command::Help));
        assert_eq!(parse(&["--help", "g.bin"]), Ok(Command::Help));
    }

    #[test]
    fn errors() {
        assert_eq!(parse(&[]), Err(ArgumentError::Usage));
        assert_eq!(parse(&["-x", "g.bin"]), Err(ArgumentError::Usage));
        assert_eq!(parse(&["--bogus", "g.bin"]), Err(ArgumentError::Usage));
        assert_eq!(parse(&["g.bin", "-b"]), Err(ArgumentError::Usage));
        assert_eq!(
            parse(&["-b", "tcg", "g.bin"]),
            Err(ArgumentError::Message("unknown backend 'tcg'".to_string()))
        );
        assert_eq!(
            parse(&["-m", "0", "g.bin"]),
            Err(ArgumentError::Message("memory must be > 0".to_string()))
        );
        assert_eq!(
            parse(&["-m", "lots", "g.bin"]),
            Err(ArgumentError::Message("memory must be > 0".to_string()))
        );
    }

    #[test]
    fn numbers_follow_strtoul() {
        assert_eq!(parse_c_unsigned("16"), 16);
        assert_eq!(parse_c_unsigned("0x10"), 16);
        assert_eq!(parse_c_unsigned("010"), 8);
        assert_eq!(parse_c_unsigned("  7abc"), 7);
        assert_eq!(parse_c_unsigned("abc"), 0);
        assert_eq!(parse_c_unsigned("0"), 0);
    }

    #[test]
    fn usage_mentions_the_entry_address() {
        let text = usage("open-vmm");
        assert!(text.starts_with("Usage: open-vmm [options] <guest.bin>"));
        assert!(text.contains("GPA 0x1000"));
        assert!(text.contains("  -b, --backend=auto|kvm|soft   CPU backend (default: auto)"));
    }
}
