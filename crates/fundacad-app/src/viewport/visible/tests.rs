use std::sync::Arc;

use serde_json::json;

use super::shown;
use crate::viewport::scene::Body;

#[test]
fn a_hidden_body_leaves_the_scene_and_the_rest_keep_their_order() {
    let body = |id: &str| Arc::new(Body { id: id.into(), ..Default::default() });
    let bodies = [body("body1"), body("body2"), body("body3")];
    let doc = json!({"bodyVisibility": {"body2": false, "body3": true}}).as_object().unwrap().clone();
    let ids: Vec<_> = shown(Some(&doc), &bodies).iter().map(|b| b.id.clone()).collect();
    assert_eq!(ids, ["body1", "body3"]);
    assert_eq!(shown(None, &bodies).len(), 3);
}
