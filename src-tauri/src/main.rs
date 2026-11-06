// Desktop builds use the Windows GUI subsystem, including diagnostic builds.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    skim_lib::run()
}
