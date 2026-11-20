#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod models;
mod shell;
mod startup;

fn main() {
    shell::run()
}
