//! Non-panicking output for the command-line surface.
//!
//! `std::print!` / `std::println!` unwrap their write result. That is friendly
//! for small programs, but wrong for a CLI hosted by an Agent: the reader may
//! intentionally close its pipe early, turning the next write into EPIPE. The
//! CLI-local macros in `cli::mod` route here and treat a closed output stream as
//! the consumer saying it no longer needs that stream. The command continues
//! to its normal business exit code instead of aborting the process.

use std::fmt;
use std::io::{self, Write};

fn write_args(writer: &mut impl Write, args: fmt::Arguments<'_>, newline: bool) -> io::Result<()> {
    writer.write_fmt(args)?;
    if newline {
        writer.write_all(b"\n")?;
    }
    Ok(())
}

pub fn write_stdout(args: fmt::Arguments<'_>) {
    let mut stdout = io::stdout().lock();
    let _ = write_args(&mut stdout, args, false);
}

pub fn write_stdout_line(args: fmt::Arguments<'_>) {
    let mut stdout = io::stdout().lock();
    let _ = write_args(&mut stdout, args, true);
}

pub fn write_stderr_line(args: fmt::Arguments<'_>) {
    let mut stderr = io::stderr().lock();
    let _ = write_args(&mut stderr, args, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
    }

    #[test]
    fn closed_pipe_is_a_write_result_not_a_panic() {
        let mut pipe = ClosedPipe;
        let result = write_args(&mut pipe, format_args!("answer={}", 42), true);
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn line_writer_appends_exactly_one_newline() {
        let mut bytes = Vec::new();
        write_args(&mut bytes, format_args!("hello"), true).unwrap();
        assert_eq!(bytes, b"hello\n");
    }
}
