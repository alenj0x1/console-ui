//! Prints whether this process can read the controller through XInput.
//! Used by the HidHide lab: whitelisted vs not.
fn main() {
    let mut pad = padcore::xinput::XInput::new();
    match pad.poll() {
        Some(_) => println!("visible (slot {})", pad.slot().unwrap_or(0)),
        None => println!("hidden"),
    }
}
