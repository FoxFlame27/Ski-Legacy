#include "game/shoproom.h"
#include "core/prompts.h"
#include "game/menus.h"
#include "game/play_data.h"
#include "game/ui_widgets.h"
#include "player/player.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

namespace {
double smooth(double x, double a, double b) { double t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t); }
double wrap(double a) { return std::atan2(std::sin(a), std::cos(a)); }
// THREE's Matrix4.lookAt(eye, target, up) as a quaternion: the camera's right, up, back
glm::dquat lookQuat(const dvec3& fwd) {
  const dvec3 z = -glm::normalize(fwd), x = glm::normalize(glm::cross(dvec3(0, 1, 0), z)), y = glm::cross(z, x);
  return glm::quat_cast(glm::dmat3(x, y, z));
}
}

ShopRoom::ShopRoom(PlayCtx& c, Interiors& rooms, WindowView& win, Ui& ui) : c_(c), rooms_(rooms), win_(win), ui_(ui) {}

bool ShopRoom::available() const { return c_.data && c_.data->shop.ok && c_.data->shop.hasDoor; }

bool ShopRoom::interact(std::string& prompt, bool pressed) {
  if (!available() || inside() || pending_) return false;
  const RoomDef& d = c_.data->shop;
  const dvec3& p = c_.player->pos;
  if (std::hypot(p.x - d.doorX, p.z - d.doorZ) > d.doorR) return false;
  prompt = "Enter the ski shop";
  if (!pressed) return false;
  enter();
  return true;
}

// main.js enterShop: through the door behind a dip to dark; on the way the plaza is photographed for the glass
void ShopRoom::enter() {
  if (!available() || inside() || pending_) return;
  const RoomDef& d = c_.data->shop;
  pending_ = true;
  if (c_.fade) c_.fade();
  c_.player->vel = dvec3(0);
  std::vector<WindowView::Shot> shots;
  std::vector<WindowView::Pane> panes;
  if (!d.panes.empty()) {
    // (interior.js setOutside / renderPortal: room +z = the way the shop faces, the glass on the facade 1.4 m behind
    // the door point; the web game carries your camera to the matching spot in the village and leaves the shop's own
    // building out. Here: one photograph from the middle of the room where it stands out there, at eye height, the
    // near plane just beyond the porch (the building round the camera is cut away); the plaza, the racks and lamps in
    // front, the people passing, the mountains)
    WindowView::Shot s;
    const dvec3 f = glm::normalize(dvec3(d.frontX, 0, d.frontZ));
    s.eyeLocal = vec3(0, float(d.eye), 0);
    s.eye = dvec3(d.doorX, 0, d.doorZ) - f * (1.4 + d.D / 2);
    s.eye.y = c_.world->height(d.doorX, d.doorZ) + d.eye;
    s.dir = f; s.local = vec3(0, 0, 1); s.halfAngle = 62;
    s.nearZ = float(d.D / 2 + 1.4 + 0.25); s.depth = 14; s.gain = 0.6f;
    shots.push_back(s);
    // (nearClutter: the signboard beside the entrance stays out of the window view in the web game: a second
    // photograph from beyond it for the windows on its side, x < 0)
    s.nearZ = float(d.D / 2 + 1.4 + 1.6);
    shots.push_back(s);
    // (the glass is one plane behind every opening, from the floor up: only above the sills here, so nothing shows
    // under the door; in two parts, one for each photograph)
    for (const RoomDef::Pane& p : d.panes) {
      const float cut = std::min(0.9f, p.h * 0.4f), split = -0.6f;
      const float px = p.m[3].x, ax = p.m[0].x >= 0 ? 1.f : -1.f, x0 = px - p.w / 2, x1 = px + p.w / 2;   // (the pane's span along the room's x)
      if (x0 >= split || x1 <= split) { panes.push_back({p.m * glm::translate(mat4(1), vec3(0, cut / 2, 0)), p.w, p.h - cut, px > split ? 0 : 1}); continue; }
      panes.push_back({p.m * glm::translate(mat4(1), vec3(((split + x1) / 2 - px) * ax, cut / 2, 0)), x1 - split, p.h - cut, 0});
      panes.push_back({p.m * glm::translate(mat4(1), vec3(((x0 + split) / 2 - px) * ax, cut / 2, 0)), split - x0, p.h - cut, 1});
    }
  }
  win_.begin(std::move(shots), std::move(panes), [this] { enterNow(); });
}

void ShopRoom::enterNow() {
  pending_ = false;
  const RoomDef& d = c_.data->shop;
  view_ = View{};
  mannequinYaw_ = PI / 2 + 0.3;
  clerkYaw_ = -PI / 2;
  rooms_.enter(Interiors::Room::Shop, [this, &d]() {
    // main.js exitShop: a couple of metres out of the door, your back to the shop
    win_.clear();
    view_ = View{};
    rooms_.clerkYaw = std::nan("");
    if (c_.fade) c_.fade();
    c_.teleport(d.doorX + d.frontX * 2.2, d.doorZ + d.frontZ * 2.2, std::atan2(d.frontX, d.frontZ), false);
    if (c_.player->hasSkis && !c_.player->skisOn) c_.flash("Press " + c_.K(Action::Skis) + " to put your skis on", 0);
  });
}

void ShopRoom::leave() {
  if (!inside()) return;
  if (c_.menus && c_.menus->customOpen("talk")) c_.menus->close();
  rooms_.leave();
}

// interior.js outfitCameraPose / talkCameraPose, in the room's frame
void ShopRoom::pose(int kind, float aspect, dvec3& pos, glm::dquat& q, double& fov) const {
  const RoomDef& d = c_.data->shop;
  dvec3 focus, fwd;
  double shiftK;
  if (kind == 2) {
    // a portrait of the clerk from across the counter: the face on the right third, a little above centre
    fov = 38;
    focus = dvec3(d.clerkX, 1.6, d.clerkZ);
    pos = dvec3(d.clerkX - 2.05, 1.58, d.clerkZ - 0.55);
    shiftK = std::min(0.4, 0.24 * double(aspect));
  } else {
    // the podium with the skier at ~68 % of the screen's width
    fov = 40;
    focus = dvec3(d.podium.x, d.podium.y + 0.86, d.podium.z);
    pos = focus + glm::normalize(dvec3(1, 0, 0.22)) * 3.45 + dvec3(0, 0.3, 0);
    shiftK = std::min(0.36, 0.22 * double(aspect));   // (narrower windows shift less)
  }
  fwd = glm::normalize(focus - pos);
  const double half = std::atan(std::tan(fov * DEG / 2) * double(aspect));
  const double a = std::atan(shiftK * std::tan(half)), ca = std::cos(a), sa = std::sin(a);
  fwd = dvec3(fwd.x * ca + fwd.z * sa, fwd.y, -fwd.x * sa + fwd.z * ca);   // (applyAxisAngle(UP, a))
  q = lookQuat(fwd);
}

void ShopRoom::outfitView(bool on) {
  if (!inside()) return;
  if (on) { view_ = View{}; view_.kind = 1; view_.on = true; }
  else if (view_.kind == 1 && view_.on) { view_.on = false; view_.t = 0; view_.backSet = false; }
}

void ShopRoom::talkEnd() {
  if (view_.kind == 2 && view_.on) { view_.on = false; view_.t = 0; view_.backSet = false; }
}

// main.js shopAction (the clerk): the conversation look; the card is this screen's own (hud.dialog in talk mode)
void ShopRoom::talk(const std::string& name, const std::string& role, const std::string& say) {
  if (!inside() || !c_.menus) return;
  view_ = View{}; view_.kind = 2; view_.on = true;
  talkName_ = name; talkRole_ = role; talkSay_ = say;
  talkAt_ = -1; talkFrames_ = 0;
  c_.menus->openCustom([this](const UiNav& nav, double, double now) {
    Ui& ui = ui_;
    if (talkAt_ < 0) talkAt_ = now;
    const double age = now - talkAt_;
    const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
    // #panel.talk: the shade from the left; the card bottom left, 4.5vw in, 12vh up (above the lower bar)
    ui.pushAlpha(float(clamp(age / 0.25, 0.0, 1.0)));
    ui.gradientGrid(0, 0, W * 0.58f, H, 29, 1, [](float fx, float) {
      const float x = fx * 0.58f, al = x < 0.30f ? 0.74f + (0.46f - 0.74f) * x / 0.30f : 0.46f * (1 - (x - 0.30f) / 0.28f);
      return vec4(0.016f, 0.055f, 0.133f, std::max(0.f, al));
    });
    ui.popAlpha();
    const float cardW = std::min(540 * d, 0.40f * W), x = 0.045f * W + 8 * d, bottom = H - 0.12f * H - 11 * d;
    const float in = 1 - std::pow(1 - float(clamp(age / 0.45, 0.0, 1.0)), 3.f);
    ui.pushAlpha(in);
    ui.pushTranslate(-26 * d * (1 - in), 0);
    // the lines' heights, from the bottom up: the foot (54u), 26u, the line (17u x 1.45 each), 12, the role, 8, the name
    const float sayS = std::max(14 * d, 17 * u), roleS = std::max(13 * d, 16 * u), nameS = 30 * d;
    const std::vector<std::string> lines = uiw::wrap(ui, talkSay_, sayS, UiFont::BodyMed, std::min(720 * u, cardW - 28 * u));
    const float bh = 54 * u, nameH = nameS * 1.15f + 12 * d;
    float y = bottom - bh - 48 * u - float(lines.size()) * sayS * 1.45f - 12 * d - roleS * 1.3f - 8 * d - nameH;
    {
      const float nw = ui.textWidth(talkName_, nameS, UiFont::CondItalic, 0.03f) + 60 * d;
      Ui::Shadow sh{0, 6 * d, 14 * d, a(hex(0x000000), 0.3f)};
      ui.brushPanel(x, y, nw, nameH, white, 0, &sh);
      ui.textLH(x + 20 * d, y, nameH, nameS, UiFont::CondItalic, blue, talkName_, UiAlign::Left, 0.03f);
      y += nameH + 8 * d;
    }
    if (!talkRole_.empty()) {
      ui.textShadow(x + 4 * d, y + (roleS * 1.3f - ui.lineHeight(roleS, UiFont::BodyMed)) / 2, roleS, UiFont::BodyMed, talkRole_, UiAlign::Left, 0, 0, d, 6 * d, a(hex(0x000000), 0.4f));
      ui.textLH(x + 4 * d, y, roleS * 1.3f, roleS, UiFont::BodyMed, a(white, 0.92f), talkRole_);
    }
    y += roleS * 1.3f + 12 * d;
    for (const std::string& l : lines) {
      ui.textShadow(x, y + (sayS * 1.45f - ui.lineHeight(sayS, UiFont::BodyMed)) / 2, sayS, UiFont::BodyMed, l, UiAlign::Left, 0, 0, d, 8 * d, a(hex(0x000a1e), 0.6f));
      ui.textLH(x, y, sayS * 1.45f, sayS, UiFont::BodyMed, white, l);
      y += sayS * 1.45f;
    }
    y += 48 * u;   // (.say's 22u below it, .dlg-foot's 26u above)
    // .dlg-sec.is-focus: THANKS, shifted 8u with the red bar; the key hint
    const std::string label = "THANKS";
    const float bw = ui.textWidth(label, 26 * u, UiFont::CondItalic, 0.05f) + 58 * u, dx = 8 * u;
    ui.rect(x - 12 * u + dx, y + bh * 0.3f, 5 * u, bh * 0.4f, red);
    Ui::Shadow sh{0, 6 * u, 12 * u, a(hex(0x000000), 0.25f)};
    ui.brushPanel(x + dx, y, bw, bh, white, 1, &sh);
    ui.textLH(x + dx + 24 * u, y, bh, 26 * u, UiFont::CondItalic, blue, label, UiAlign::Left, 0.05f);
    uiw::hints(ui, x + bw + 18 * u, y + bh / 2 - ui.kcHeight(u) / 2, u, {{{prompts::K(*c_.input, "cancel")}, "CLOSE"}});
    ui.popTransform();
    ui.popAlpha();
    const bool over = nav.mouse.x >= x && nav.mouse.x <= x + dx + bw && nav.mouse.y >= y && nav.mouse.y <= y + bh;
    bool key = false;
    if (!nav.usingPad) for (platform::Key k : nav.keys) key = key || k == platform::Key::KeyE;
    if (++talkFrames_ > 1 && (nav.confirm || nav.cancel || nav.menu || key || (nav.click && over))) { c_.menus->close(); talkEnd(); }
  }, "talk");
}

void ShopRoom::update(double dt) {
  if (!inside()) { bars_ = 0; return; }
  const RoomDef& d = c_.data->shop;
  if (view_.kind == 2 && view_.on && c_.menus && !c_.menus->customOpen("talk")) talkEnd();   // (the card closed some other way)
  if (view_.kind == 1 && view_.on && c_.menus && !c_.menus->customOpen("shop")) outfitView(false);
  if (view_.kind) view_.t += dt;
  // the clerk turns to you in a conversation, back to the room after it
  const dvec3 cl = dvec3(d.clerkX, 0, d.clerkZ);
  const double want = view_.kind == 2 && view_.on ? std::atan2(camPos_.x - cl.x, camPos_.z - cl.z) : -PI / 2;
  clerkYaw_ += wrap(want - clerkYaw_) * (1 - std::exp(-dt * 5));
  rooms_.clerkYaw = clerkYaw_;
  // the podium skier: relaxed, turned to the camera in the outfit view (a drag spins it)
  double heading = PI / 2 - 0.3;
  if (view_.kind == 1) {
    const double toCam = std::atan2(camPos_.x - d.podium.x, camPos_.z - d.podium.z) + 0.38;
    const double k = view_.on ? smooth(view_.t, 0, 0.5) : 1 - smooth(view_.t, 0, 0.5);
    heading = heading + (toCam - heading) * k + view_.spin * k;
  }
  mannequinYaw_ += wrap(heading - mannequinYaw_) * (1 - std::exp(-dt * 6));
  // the bars (talk.js #talk-bars: 0.6 s, cubic-bezier(.65, 0, .35, 1))
  const double to = view_.kind == 2 && view_.on ? 1 : 0;
  bars_ = clamp(bars_ + (to > bars_ ? 1 : -1) * dt / 0.6, 0.0, 1.0);
}

bool ShopRoom::mannequin(dvec3& pos, double& yaw) const {
  if (!inside()) return false;
  const RoomDef& d = c_.data->shop;
  pos = rooms_.toWorld(d.podium.x, d.podium.y, d.podium.z);
  yaw = mannequinYaw_;
  return true;
}

// interior.js updateView: from your eyes to the view's pose over 0.65 s (smoothstep) and back
void ShopRoom::camera(Camera& cam) {
  if (!inside()) return;
  const dvec3 o = rooms_.toWorld(0, 0, 0);
  {
    // interior.js update: your eyes 1.62 m over the floor (a hint of a bob with your steps), a 70 degree view
    const RoomDef& d = c_.data->shop;
    const dvec3 l = rooms_.toLocal(c_.player->renderPos);
    cam.pos = o + dvec3(l.x, d.eye + std::sin(l.x * 2 + l.z * 2) * 0.01, l.z);
    cam.fovY = 70; cam.nearZ = 0.05f;
    if (dbg_) {
      cam.pos = o + dvec3(dbgPos_.x, d.eye + std::sin(dbgPos_.x * 2 + dbgPos_.z * 2) * 0.01, dbgPos_.z);
      cam.lookAt(cam.pos, cam.pos + dvec3(std::sin(dbgYaw_) * std::cos(dbgPitch_), std::sin(dbgPitch_), std::cos(dbgYaw_) * std::cos(dbgPitch_)));
    }
  }
  if (view_.kind) {
    const dvec3 eye = cam.pos;
    const glm::dquat eyeQ = glm::quat_cast(glm::dmat3(cam.basis));
    const double eyeFov = cam.fovY;
    if (!view_.fromSet) { view_.fromSet = true; view_.fromPos = eye; view_.fromQ = eyeQ; view_.fromFov = eyeFov; }
    dvec3 pos; glm::dquat q; double fov = 40;
    pose(view_.kind, cam.aspect, pos, q, fov);
    pos += o;
    const double k = smooth(view_.t, 0, 0.65);
    dvec3 P; glm::dquat Q; double F;
    if (view_.on) { P = glm::mix(view_.fromPos, pos, k); Q = glm::slerp(view_.fromQ, q, k); F = view_.fromFov + (fov - view_.fromFov) * k; }
    else {
      if (!view_.backSet) { view_.backSet = true; view_.backPos = pos; view_.backQ = q; view_.backFov = fov; }
      P = glm::mix(view_.backPos, eye, k); Q = glm::slerp(view_.backQ, eyeQ, k); F = view_.backFov + (eyeFov - view_.backFov) * k;
      if (k >= 1) view_ = View{};
    }
    cam.pos = P;
    cam.basis = mat3(glm::mat3_cast(Q));
    cam.fovY = float(F);
    cam.nearZ = 0.05f;
  }
  camPos_ = cam.pos - o;
}

void ShopRoom::hud(Ui& ui, bool crosshair) {
  if (!inside()) return;
  const float W = float(ui.width()), H = float(ui.height());
  if (bars_ > 0.001) {
    // (cubic-bezier(.65, 0, .35, 1): close to a smoothstep)
    const float k = float(smooth(bars_, 0, 1)), bh = 0.085f * H;
    ui.rect(0, -bh * (1 - k), W, bh, hex(0x04070d));
    ui.rect(0, H - bh * k, W, bh, hex(0x04070d));
  }
  if (crosshair && !view_.kind) Interiors::crosshair(ui);
}

} // namespace sl
