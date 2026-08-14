//! tfhe-rs parametrelerini Concrete'in bekledigi JSON olarak dogrular.
use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2_KS_PBS_GAUSSIAN_2M64 as P;

#[test]
fn dump_params() {
    let json = serde_json::to_string_pretty(&P).unwrap();
    println!("{json}");
}
