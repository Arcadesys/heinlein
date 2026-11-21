use super::{check_window, with_repository};
use base64::{engine::general_purpose::STANDARD, Engine};
use repository_core::illustrations::Illustration;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

struct Pick {
    id: String,
    project: String,
    scene: String,
    image: Arc<Illustration>,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Default)]
pub struct ImageHost(Mutex<Option<Pick>>);
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Pick,
    Read { url: String },
    Commit { id: String },
    Describe { id: String },
    Discard { id: String },
}

#[tauri::command]
pub async fn illustration_request(
    app: AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    scene: String,
    request: Request,
) -> Result<Value, String> {
    check_window(&window)?;
    if let Request::Describe { id } = &request {
        let (image, mut cancel) = pending(&app, &repository_id, &scene, id)?;
        let png = tauri::async_runtime::spawn_blocking(move || {
            image
                .description_png()
                .map(|bytes| STANDARD.encode(bytes))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        if *cancel.borrow() {
            return Err("Description canceled.".into());
        }
        return tokio::select! {
            _=cancel.changed()=>Err("Description canceled.".into()),
            result=crate::questions::draft_image_description(&app,png)=>result.map(Value::String)
        };
    }
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<ImageHost>();
        match request {
            Request::Pick => {
                with_repository(&app, &repository_id, |r| {
                    r.read(&scene).map(|_| ()).map_err(|e| e.to_string())
                })?;
                let Some(path) = app
                    .dialog()
                    .file()
                    .add_filter("Illustration", &["png", "jpg", "jpeg"])
                    .blocking_pick_file()
                else {
                    return Ok(Value::Null);
                };
                let path = path.into_path().map_err(|_| "Choose a local file.")?;
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or("Invalid filename.")?;
                let mut options = std::fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(
                        (rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOFOLLOW).bits() as i32,
                    );
                }
                let image = Illustration::read(
                    options
                        .open(&path)
                        .map_err(|_| "Cannot read this illustration.")?,
                )
                .map_err(|e| e.to_string())?;
                let id = uuid::Uuid::new_v4().to_string();
                let reply = json!({"id":id,"name":name,"width":image.width,"height":image.height});
                with_repository(&app, &repository_id, |_| {
                    *host.0.lock().map_err(|_| "Illustration unavailable.")? = Some(Pick {
                        id,
                        project: repository_id.clone(),
                        scene,
                        image: Arc::new(image),
                        cancel: tokio::sync::watch::channel(false).0,
                    });
                    Ok(reply)
                })
            }
            Request::Read { url } => with_repository(&app, &repository_id, |r| {
                let image = r
                    .read_image(&scene, &url)
                    .map_err(|e| format!("{scene}: {url} — {e}"))?;
                Ok(Value::String(format!(
                    "data:{};base64,{}",
                    image.mime(),
                    STANDARD.encode(&image.bytes)
                )))
            }),
            Request::Commit { id } => {
                let (image, _) = pending(&app, &repository_id, &scene, &id)?;
                with_repository(&app, &repository_id, |r| {
                    r.import_image(&scene, &image)
                        .map(Value::String)
                        .map_err(|e| e.to_string())
                })
            }
            Request::Discard { id } => {
                let mut pick = host.0.lock().map_err(|_| "Illustration unavailable.")?;
                if pick
                    .as_ref()
                    .is_some_and(|p| p.id == id && p.scene == scene && p.project == repository_id)
                {
                    if let Some(p) = pick.take() {
                        let _ = p.cancel.send(true);
                    }
                }
                Ok(Value::Null)
            }
            Request::Describe { .. } => unreachable!(),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pending(
    app: &AppHandle,
    project: &str,
    scene: &str,
    id: &str,
) -> Result<(Arc<Illustration>, tokio::sync::watch::Receiver<bool>), String> {
    with_repository(app, project, |_| {
        let host = app.state::<ImageHost>();
        let guard = host.0.lock().map_err(|_| "Illustration unavailable.")?;
        let pick = guard
            .as_ref()
            .filter(|p| p.id == id && p.project == project && p.scene == scene)
            .ok_or("Choose the illustration again.")?;
        Ok((pick.image.clone(), pick.cancel.subscribe()))
    })
}
