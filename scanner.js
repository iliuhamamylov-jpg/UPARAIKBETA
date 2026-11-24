let cameraSession;
function stopCamera() {
  const session = cameraSession;
  if (!session) return;
  cameraSession = null;
  clearTimeout(session.timer);
  session.stream?.getTracks().forEach((track) => track.stop());
  session.video.srcObject = null;
  session.reader.hidden = true;
  session.button.disabled = false;
  session.status.textContent = "";
}
async function scanTicket(button) {
  stopCamera();
  const reader = document.querySelector("#reader");
  const video = reader.querySelector("video");
  const status = document.querySelector("#camera-status");
  const form = document.querySelector("#lookup");
  form.elements.code.value = "";
  form.elements.code.dispatchEvent(new Event("input", { bubbles: true }));
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Откройте админку по HTTPS для доступа к камере.";
    return;
  }
  const session = { reader, video, button, status };
  cameraSession = session;
  button.disabled = true;
  reader.hidden = false;
  status.textContent = "Разрешите доступ к камере.";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    if (cameraSession !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    stream.getVideoTracks()[0].onended = () => {
      if (cameraSession === session) stopCamera();
    };
    video.srcObject = stream;
    await video.play();
    if (cameraSession !== session) return;
    status.textContent = "Наведите камеру на QR-код билета.";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    function read() {
      if (cameraSession !== session) return;
      if (!reader.isConnected) {
        stopCamera();
        return;
      }
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(
          1,
          800 / Math.max(video.videoWidth, video.videoHeight),
        );
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const qr = jsQR(pixels.data, pixels.width, pixels.height, {
          inversionAttempts: "dontInvert",
        });
        if (qr && /^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/i.test(qr.data)) {
          stopCamera();
          form.elements.code.value = qr.data;
          form.requestSubmit();
          return;
        }
        if (qr) status.textContent = "Это не QR-код билета Афиши.";
      }
      session.timer = setTimeout(read, 120);
    }
    read();
  } catch (err) {
    if (cameraSession !== session) return;
    stopCamera();
    status.textContent =
      err.name === "NotAllowedError"
        ? "Доступ к камере закрыт. Разрешите его в настройках сайта или введите номер."
        : "Не удалось открыть камеру. Проверьте устройство или введите номер билета.";
  }
}
document.addEventListener("click", (e) => {
  if (e.target.id === "scan") scanTicket(e.target);
  if (e.target.id === "stop-scan") stopCamera();
});
document.addEventListener("submit", stopCamera, true);
window.addEventListener("pagehide", stopCamera);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
});

const qrFileInput = document.querySelector("#qr-file");
qrFileInput.addEventListener("change", async () => {
  const file = qrFileInput.files[0];
  if (!file) return;
  stopCamera();
  const status = document.querySelector("#camera-status");
  const form = document.querySelector("#lookup");
  form.elements.code.value = "";
  form.elements.code.dispatchEvent(new Event("input", { bubbles: true }));
  qrFileInput.disabled = true;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height);
    if (!result || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/i.test(result.data))
      throw Error();
    status.textContent = "";
    form.elements.code.value = result.data;
    form.requestSubmit();
  } catch {
    status.textContent =
      "Не удалось прочитать QR билета. Выберите другое изображение или введите номер.";
  } finally {
    URL.revokeObjectURL(url);
    qrFileInput.disabled = false;
    qrFileInput.value = "";
  }
});
