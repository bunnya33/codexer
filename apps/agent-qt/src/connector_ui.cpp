#include "connector_ui.h"
#include <cmath>

namespace {
class LogRow : public QStyledItemDelegate {
public:
  using QStyledItemDelegate::QStyledItemDelegate;
  QSize sizeHint(const QStyleOptionViewItem &,
                 const QModelIndex &) const override {
    return {320, 58};
  }
  void paint(QPainter *p, const QStyleOptionViewItem &option,
             const QModelIndex &index) const override {
    const auto lines = index.data().toString().split('\n');
    if (lines.size() < 3)
      return;
    p->save();
    auto r = option.rect;
    p->fillRect(r, option.state & QStyle::State_Selected ? QColor("#edf3ff")
                                                         : QColor(Qt::white));
    p->setPen(QColor("#eef1f6"));
    p->drawLine(r.bottomLeft(), r.bottomRight());
    auto font = option.font;
    font.setPixelSize(11);
    p->setFont(font);
    p->setPen(QColor("#a2adbc"));
    p->drawText(r.adjusted(0, 10, -5, -10), Qt::AlignTop, lines[0]);
    font.setPixelSize(12);
    p->setFont(font);
    p->setPen(QColor("#738198"));
    p->drawText(r.adjusted(82, 8, -5, -20), Qt::AlignTop, lines[1]);
    font.setPixelSize(10);
    p->setFont(font);
    p->setPen(QColor("#a5afbf"));
    p->drawText(r.adjusted(82, 30, -5, -3), Qt::AlignTop, lines[2]);
    p->restore();
  }
};
QLabel *text(QString value, QString role = {}, bool wrap = false) {
  auto label = new QLabel(value);
  label->setTextFormat(Qt::PlainText);
  label->setProperty("role", role);
  label->setWordWrap(wrap);
  return label;
}
QVBoxLayout *column(QWidget *widget, int margin = 0, int spacing = 0) {
  auto layout = new QVBoxLayout(widget);
  layout->setContentsMargins(margin, margin, margin, margin);
  layout->setSpacing(spacing);
  return layout;
}
QHBoxLayout *row(QWidget *widget, int spacing = 9) {
  auto layout = new QHBoxLayout(widget);
  layout->setContentsMargins(0, 0, 0, 0);
  layout->setSpacing(spacing);
  return layout;
}
QFrame *card(QVBoxLayout *layout, QString name = {}) {
  auto frame = new QFrame;
  frame->setProperty("card", true);
  frame->setObjectName(name);
  layout->addWidget(frame);
  return frame;
}
QLabel *title(QVBoxLayout *layout, QString value) {
  auto label = text(value, "h2");
  layout->addWidget(label);
  return label;
}
QIcon icon(QString name, QColor color = QColor("#738198"), int size = 20) {
  QPixmap pixmap(size * 2, size * 2);
  pixmap.fill(Qt::transparent);
  QPainter p(&pixmap);
  p.scale(size / 12.0, size / 12.0);
  p.setRenderHint(QPainter::Antialiasing);
  p.setPen(QPen(color, 1.65, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
  auto line = [&](qreal x, qreal y, qreal a, qreal b) {
    p.drawLine(QPointF(x, y), QPointF(a, b));
  };
  if (name == "terminal") {
    p.drawRoundedRect(QRectF(3, 4, 18, 16), 2, 2);
    line(6, 8, 10, 12);
    line(10, 12, 6, 16);
    line(13, 16, 17, 16);
  } else if (name == "settings") {
    for (int y : {6, 12, 18})
      line(3, y, 21, y);
    p.setBrush(Qt::white);
    for (auto point : {QPointF(8, 6), QPointF(16, 12), QPointF(10, 18)})
      p.drawEllipse(point, 2, 2);
  } else if (name == "activity") {
    line(2, 12, 6, 12);
    line(6, 12, 9, 4);
    line(9, 4, 14, 20);
    line(14, 20, 17, 12);
    line(17, 12, 22, 12);
  } else if (name == "radio") {
    p.drawEllipse(QPointF(12, 12), 2, 2);
    for (int r : {6, 10}) {
      p.drawArc(QRectF(12 - r, 12 - r, 2 * r, 2 * r), -45 * 16, 90 * 16);
      p.drawArc(QRectF(12 - r, 12 - r, 2 * r, 2 * r), 135 * 16, 90 * 16);
    }
  } else if (name == "laptop") {
    p.drawRoundedRect(QRectF(5, 4, 14, 12), 1, 1);
    line(5, 16, 2, 20);
    line(2, 20, 22, 20);
    line(22, 20, 19, 16);
  } else if (name == "server") {
    for (int y : {3, 14}) {
      p.drawRoundedRect(QRectF(3, y, 18, 7), 2, 2);
      line(7, y + 3, 7, y + 3.1);
    }
  } else if (name == "folder") {
    QPainterPath path;
    path.moveTo(3, 20);
    path.lineTo(3, 5);
    path.lineTo(9, 5);
    path.lineTo(11, 8);
    path.lineTo(21, 8);
    path.lineTo(21, 20);
    path.closeSubpath();
    p.drawPath(path);
  } else if (name == "shield") {
    QPainterPath path;
    path.moveTo(12, 2);
    path.lineTo(21, 6);
    path.lineTo(20, 14);
    path.quadTo(18, 20, 12, 22);
    path.quadTo(6, 20, 4, 14);
    path.lineTo(3, 6);
    path.closeSubpath();
    p.drawPath(path);
    line(8, 12, 11, 15);
    line(11, 15, 16, 9);
  } else if (name == "check") {
    line(5, 12, 10, 17);
    line(10, 17, 20, 6);
  } else if (name == "close") {
    line(6, 6, 18, 18);
    line(18, 6, 6, 18);
  } else if (name == "minus")
    line(5, 12, 19, 12);
  else if (name == "maximize")
    p.drawRect(QRectF(6, 6, 12, 12));
  else if (name == "restore") {
    p.drawRect(QRectF(5, 8, 11, 11));
    line(9, 5, 19, 5);
    line(19, 5, 19, 15);
  } else if (name == "refresh") {
    p.drawArc(QRectF(4, 4, 16, 16), 30 * 16, 290 * 16);
    line(20, 3, 20, 9);
    line(20, 9, 14, 9);
  } else if (name == "external") {
    line(14, 3, 21, 3);
    line(21, 3, 21, 10);
    line(21, 3, 11, 13);
    QPainterPath path;
    path.moveTo(10, 5);
    path.lineTo(4, 5);
    path.lineTo(4, 20);
    path.lineTo(19, 20);
    path.lineTo(19, 14);
    p.drawPath(path);
  } else if (name == "arrow") {
    line(4, 12, 20, 12);
    line(14, 6, 20, 12);
    line(20, 12, 14, 18);
  } else if (name == "download") {
    line(12, 3, 12, 16);
    line(7, 11, 12, 16);
    line(12, 16, 17, 11);
    line(4, 17, 4, 21);
    line(4, 21, 20, 21);
    line(20, 21, 20, 17);
  } else if (name == "logout") {
    line(10, 4, 4, 4);
    line(4, 4, 4, 20);
    line(4, 20, 10, 20);
    line(9, 12, 22, 12);
    line(17, 7, 22, 12);
    line(22, 12, 17, 17);
  } else if (name == "help") {
    p.drawEllipse(QPointF(12, 12), 9, 9);
    p.drawArc(QRectF(9, 6, 6, 7), 0, 180 * 16);
    line(15, 9, 12, 13);
    line(12, 13, 12, 14);
    line(12, 18, 12, 18.1);
  } else {
    line(8, 3, 8, 8);
    line(16, 3, 16, 8);
    p.drawRoundedRect(QRectF(5, 8, 14, 8), 2, 2);
    line(12, 16, 12, 22);
    if (name == "unplug")
      line(3, 3, 21, 21);
  }
  p.end();
  pixmap.setDevicePixelRatio(2);
  return QIcon(pixmap);
}
QPushButton *button(QString caption, QString name, QString image = {},
                    bool primary = false) {
  auto b = new QPushButton(caption);
  b->setObjectName(name);
  b->setCursor(Qt::PointingHandCursor);
  b->setProperty("primary", primary);
  if (!image.isEmpty())
    b->setIcon(
        icon(image, primary ? QColor(Qt::white) : QColor("#738198"), 16));
  b->setIconSize({16, 16});
  b->setAutoDefault(false);
  return b;
}
QWidget *field(QString caption, QLineEdit *&edit, QString name,
               QString placeholder = {}) {
  auto w = new QWidget;
  auto l = column(w, 0, 7);
  l->addWidget(text(caption, "label"));
  edit = new QLineEdit;
  edit->setObjectName(name);
  edit->setPlaceholderText(placeholder);
  l->addWidget(edit);
  return w;
}
QWidget *hint(QString caption, QString image = "help") {
  auto w = new QWidget;
  auto l = row(w);
  auto glyph = new QLabel;
  glyph->setPixmap(icon(image, QColor("#99a6b7"), 17).pixmap(17, 17));
  l->addWidget(glyph, 0, Qt::AlignTop);
  l->addWidget(text(caption, "small", true), 1);
  return w;
}
class Toggle : public QCheckBox {
public:
  explicit Toggle(QWidget *parent = nullptr) : QCheckBox(parent) {
    setFixedSize(34, 24);
    setCursor(Qt::PointingHandCursor);
  }
  void paintEvent(QPaintEvent *) override {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setPen(Qt::NoPen);
    p.setBrush(isChecked() ? QColor("#326aeb") : QColor("#dbe2ed"));
    p.drawRoundedRect(QRectF(0, 2, 34, 20), 10, 10);
    p.setBrush(Qt::white);
    p.drawEllipse(QRectF(isChecked() ? 17 : 3, 5, 14, 14));
    if (hasFocus()) {
      p.setPen(QPen(QColor("#85adff"), 1));
      p.setBrush(Qt::NoBrush);
      p.drawRoundedRect(rect().adjusted(0, 0, -1, -1), 11, 11);
    }
  }
  bool hitButton(const QPoint &p) const override { return rect().contains(p); }
};
QString phaseLabel(QString phase) {
  return QMap<QString, QString>{{"signed-out", "未登录"},
                                {"disconnected", "已断开"},
                                {"connecting", "正在连接"},
                                {"connected", "已连接"},
                                {"reconnecting", "正在重连"}}
      .value(phase, "正在启动");
}
QString timeText(QJsonValue value, bool full = false) {
  return value.isDouble()
             ? QDateTime::fromMSecsSinceEpoch(qint64(value.toDouble()))
                   .toString(full ? "yyyy/M/d HH:mm:ss" : "HH:mm:ss")
             : "—";
}
QString diagnostic(QString code) {
  static const QMap<QString, QString> names{
      {"console-ready", "控制台已就绪"},
      {"settings-saved", "设置已保存"},
      {"relay-connected", "已连接服务器"},
      {"remote-paused", "远程连接已暂停"},
      {"account-login-succeeded", "账号登录成功"},
      {"account-logged-out", "已退出账号"},
      {"relay-unavailable", "服务器暂时不可达"},
      {"codex-binary-found", "已找到 Codex 运行程序"},
      {"codex-binary-not-found", "未找到 Codex 程序，请在设置中选择路径"},
      {"headless-app-server-unavailable",
       "Codex 运行服务不可用，请检查安装及官方登录状态"},
      {"catalog-refresh-failed", "无法更新本机会话目录"},
      {"account-session-expired-login-again", "会话过期，请重新登录"},
      {"account-session-ended-login-again", "账号登录已被撤销"},
      {"agent-connection-replaced", "连接被其他实例替换"},
      {"agent-started", "本机服务已启动"},
      {"worker-exited", "本机服务已退出"},
      {"logout-server-unreachable", "已清除本机登录，服务器注销暂未确认"},
      {"codex-runtime-refreshed", "Codex 运行时已刷新"},
      {"codex-runtime-refresh-deferred", "运行时正在使用，已安排空闲后刷新"},
      {"codex-runtime-current", "已检查运行时，无需切换"},
      {"codex-runtime-refresh-failed",
       "运行时刷新失败，请检查 Codex 安装后重试"}};
  return names.value(code, code);
}
} // namespace

ConnectorUi::ConnectorUi(QWidget *parent) : QWidget(parent) {
  setObjectName("connectorRoot");
  auto root = column(this);
  auto titlebar = new QWidget;
  titlebar->setObjectName("titlebar");
  titlebar->setFixedHeight(46);
  titlebar->installEventFilter(this);
  auto bar = row(titlebar, 0);
  auto appTitle = text("Codexer Agent  ·  桌面连接器", "windowTitle");
  appTitle->setAttribute(Qt::WA_TransparentForMouseEvents);
  bar->addWidget(appTitle, 1);
  for (const auto &id : QStringList{"minimize", "maximize", "close"}) {
    auto b = button({}, id, id == "minimize" ? "minus" : id);
    b->setProperty("windowControl", true);
    b->setFixedSize(46, 46);
    b->setAccessibleName(id == "minimize"   ? "最小化"
                         : id == "maximize" ? "最大化"
                                            : "关闭窗口");
    bar->addWidget(b);
    connect(b, &QPushButton::clicked, this, [this, id] {
      if (id == "minimize")
        window()->showMinimized();
      else if (id == "close")
        window()->close();
      else {
        window()->isMaximized() ? window()->showNormal()
                                : window()->showMaximized();
      }
    });
  }
  root->addWidget(titlebar);
  auto body = new QWidget;
  auto bodyRow = row(body, 0);
  root->addWidget(body, 1);
  sidebar = new QFrame;
  sidebar->setObjectName("sidebar");
  sidebar->setFixedWidth(216);
  auto side = column(sidebar);
  side->setContentsMargins(17, 30, 17, 18);
  auto brand = new QWidget;
  auto brandRow = row(brand, 12);
  brandRow->setContentsMargins(9, 0, 0, 30);
  auto terminal = new QLabel;
  terminal->setPixmap(icon("terminal", Qt::white, 22).pixmap(22, 22));
  terminal->setFixedSize(40, 40);
  terminal->setAlignment(Qt::AlignCenter);
  terminal->setObjectName("brandIcon");
  brandRow->addWidget(terminal);
  auto words = new QWidget;
  auto wl = column(words);
  wl->addWidget(text("Codexer Agent", "brand"));
  wl->addWidget(text("PC 连接器", "small"));
  brandRow->addWidget(words);
  side->addWidget(brand);
  const QStringList captions{"连接状态", "设置", "诊断日志"},
      details{"设备与远程连接", "账号、设备与启动", "连接与运行检查"},
      images{"radio", "settings", "activity"};
  for (int n = 0; n < 3; n++) {
    auto b = button({}, "nav" + QString::number(n));
    b->setProperty("nav", true);
    b->setCheckable(true);
    b->setFixedHeight(64);
    b->setAccessibleName(captions[n]);
    auto l = row(b, 13);
    l->setContentsMargins(12, 10, 12, 10);
    auto image = new QLabel;
    image->setPixmap(icon(images[n]).pixmap(20, 20));
    l->addWidget(image);
    auto labels = new QWidget;
    labels->setAttribute(Qt::WA_TransparentForMouseEvents);
    auto ll = column(labels, 0, 3);
    ll->addWidget(text(captions[n], "navTitle"));
    ll->addWidget(text(details[n], "navSmall"));
    l->addWidget(labels, 1);
    side->addWidget(b);
    navigation.append(b);
    connect(b, &QPushButton::clicked, this, [this, n] { selectPage(n); });
  }
  side->addStretch();
  side->addWidget(hint("凭据由系统安全保存\nWindows / macOS", "shield"));
  version = text("Codexer Agent", "version");
  side->addWidget(version);
  bodyRow->addWidget(sidebar);
  scroll = new QScrollArea;
  scroll->setObjectName("mainScroll");
  scroll->setWidgetResizable(true);
  scroll->setFrameShape(QFrame::NoFrame);
  scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  auto content = new QWidget;
  content->setObjectName("mainContent");
  auto main = column(content);
  main->setContentsMargins(38, 30, 38, 0);
  main->setSpacing(18);
  auto header = new QWidget;
  auto hl = row(header);
  auto headings = new QWidget;
  auto headingsLayout = column(headings, 0, 4);
  headingsLayout->addWidget(text("LOCAL CONNECTOR", "eyebrow"));
  heading = text("连接状态", "h1");
  subtitle = text("让控制端安全连接到这台电脑", "muted");
  headingsLayout->addWidget(heading);
  headingsLayout->addWidget(subtitle);
  hl->addWidget(headings, 1);
  badge = text("●  未登录", "badge");
  hl->addWidget(badge, 0, Qt::AlignVCenter);
  main->addWidget(header);
  notice = new QFrame;
  notice->setObjectName("notice");
  auto nl = row(notice);
  nl->setContentsMargins(16, 10, 16, 10);
  noticeText = text({}, "noticeText", true);
  nl->addWidget(noticeText, 1);
  auto openLogs = button("查看诊断", "openDiagnostics");
  nl->addWidget(openLogs);
  connect(openLogs, &QPushButton::clicked, this, [this] { selectPage(2); });
  notice->hide();
  main->addWidget(notice);
  pages = new QStackedWidget;
  pages->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Maximum);
  pages->addWidget(connectionPage());
  pages->addWidget(settingsPage());
  pages->addWidget(logsPage());
  main->addWidget(pages);
  main->addStretch();
  auto footer = new QWidget;
  footer->setObjectName("footer");
  auto fl = row(footer);
  fl->setContentsMargins(0, 16, 0, 16);
  footerDevice = text({}, "small");
  footerTime = text("本机服务尚未启动", "small");
  fl->addWidget(footerDevice, 1);
  fl->addWidget(footerTime);
  main->addWidget(footer);
  scroll->setWidget(content);
  bodyRow->addWidget(scroll, 1);
#ifdef Q_OS_WIN
  const QString family = "Microsoft YaHei UI";
#elif defined(Q_OS_MACOS)
  const QString family = "PingFang SC";
#else
  const QString family = QApplication::font().family();
#endif
  // A nonexistent cross-platform fallback here makes Windows Qt enumerate many
  // unrelated fonts.
  setStyleSheet(
      QString("QWidget{font-family:'%1';font-size:13px;color:#203047;} ")
          .arg(family) +
      R"(
    QWidget#connectorRoot,QWidget#mainContent{background:#f5f7fb;}
    QWidget#titlebar{background:white;border-bottom:1px solid #e1e6ef;}
    QLabel{background:transparent;border:0;} QLabel[role=windowTitle]{font-size:12px;padding-left:20px;}
    QFrame#sidebar{background:white;border-right:1px solid #e2e7f0;} QLabel#brandIcon{background:#326aeb;border-radius:11px;}
    QLabel[role=brand]{font-size:15px;font-weight:700;} QLabel[role=version]{font-size:11px;color:#a0aabd;border-top:1px solid #edf0f6;padding:15px 9px 0;}
    QLabel[role=h1]{font-size:26px;font-weight:700;} QLabel[role=h2]{font-size:16px;font-weight:600;}
    QLabel[role=eyebrow]{font-size:10px;font-weight:600;color:#9aa6b6;} QLabel[role=muted],QLabel[role=label]{font-size:12px;color:#8591a3;}
    QLabel[role=small],QLabel[role=navSmall]{font-size:11px;color:#99a6b7;} QLabel[role=navTitle]{font-size:13px;font-weight:600;color:#41516a;}
    QLabel[role=badge]{font-size:12px;padding:7px 12px;border:1px solid #e0e5ec;border-radius:16px;color:#8592a4;background:white;}
    QLabel[role=badge][connected=true]{color:#168966;background:#eaf8f1;border-color:#cbeadc;}
    QFrame[card=true]{background:white;border:1px solid #e1e6ef;border-radius:12px;} QFrame#connectionCard{background:white;}
    QPushButton{background:white;color:#37475f;border:1px solid #dce3ed;border-radius:8px;padding:9px 14px;} QPushButton:hover{background:#f0f4fa;}
    QPushButton:disabled{color:#aeb7c6;background:#f5f7fa;border-color:#e5e9f0;} QPushButton:focus{border:2px solid #b0c9ff;padding:8px 13px;}
    QPushButton[primary=true]{background:#326aeb;border-color:#326aeb;color:white;} QPushButton[primary=true]:hover{background:#245bd7;} QPushButton[primary=true]:disabled{background:#a7c0f5;border-color:#a7c0f5;}
    QPushButton[nav=true]{border:0;background:transparent;text-align:left;margin-bottom:6px;} QPushButton[nav=true]:checked{background:#edf3ff;}
    QPushButton[nav=true]:checked QLabel[role=navTitle]{color:#326aeb;} QPushButton[windowControl=true]{border:0;border-radius:0;padding:0;background:transparent;} QPushButton#close:hover{background:#e85252;}
    QLineEdit,QComboBox{padding:10px 12px;border:1px solid #dce3ed;border-radius:7px;background:#fcfdff;color:#31415b;selection-background-color:#326aeb;min-height:18px;}
    QLineEdit:focus,QComboBox:focus{border:2px solid #b0c9ff;padding:9px 11px;} QComboBox::drop-down{border:0;width:24px;}
    QPlainTextEdit{border:0;background:white;color:#738198;} QScrollArea{background:transparent;border:0;} QScrollBar:vertical{background:transparent;width:8px;} QScrollBar::handle:vertical{background:#dce3ed;border-radius:4px;min-height:28px;} QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0;} QScrollBar::add-page:vertical,QScrollBar::sub-page:vertical{background:transparent;}
    QWidget#footer{border-top:1px solid #e5eaf2;} QFrame#notice{background:#fff0ef;border:1px solid #f2d7d5;border-radius:8px;} QFrame#notice QLabel{color:#b34d48;font-size:12px;}
    QFrame#notice[success=true]{background:#eaf8f1;border-color:#cbeadc;} QFrame#notice[success=true] QLabel{color:#268060;}
    QDialog{background:white;} QDialog#confirmation{border:1px solid #b2bdcc;} QWidget#connectionActions{background:#fafbfe;border-top:1px solid #e9edf5;}
  )");
  selectPage(0);
  window()->installEventFilter(this);
  // A connector starts as a status window. Only an explicit edit should
  // activate third-party input-method modules and allocate their dictionaries.
  setFocusPolicy(Qt::StrongFocus);
  setFocus(Qt::OtherFocusReason);
}

QWidget *ConnectorUi::connectionPage() {
  auto page = new QWidget;
  auto layout = column(page, 0, 18);
  securityNotice = text(
      "正在等待系统安全存储就绪。如有 macOS 钥匙串提示，请先完成系统授权。",
      "muted", true);
  layout->addWidget(securityNotice);
  connectionCard = card(layout, "connectionCard");
  auto cl = column(connectionCard);
  auto top = new QWidget;
  auto tl = row(top);
  tl->setContentsMargins(24, 20, 24, 0);
  tl->addWidget(text("REMOTE CONNECTION", "eyebrow"), 1);
  tl->addWidget(text("账号会话 · 加密保存", "small"));
  cl->addWidget(top);
  auto diagram = new QWidget;
  auto dl = row(diagram, 20);
  dl->setContentsMargins(35, 20, 35, 26);
  auto endpoint = [&](QString image, QLabel *&name, QString detail) {
    auto w = new QWidget;
    auto l = column(w, 0, 7);
    auto glyph = new QLabel;
    glyph->setPixmap(icon(image, QColor("#728aa9"), 32).pixmap(32, 32));
    glyph->setAlignment(Qt::AlignCenter);
    glyph->setFixedSize(66, 66);
    glyph->setStyleSheet(
        "background:#f2f5fa;border:1px solid #e4e9f0;border-radius:16px;");
    l->addWidget(glyph, 0, Qt::AlignHCenter);
    name = text({}, "label");
    name->setAlignment(Qt::AlignCenter);
    name->setWordWrap(true);
    l->addWidget(name);
    auto sub = text(detail, "small");
    sub->setAlignment(Qt::AlignCenter);
    l->addWidget(sub);
    return w;
  };
  dl->addWidget(endpoint("laptop", diagramDevice, "当前电脑"), 2);
  linkStatus = text("· · · ·  未登录  · · · ·", "small");
  linkStatus->setAlignment(Qt::AlignCenter);
  dl->addWidget(linkStatus, 1);
  QLabel *serverTitle;
  auto server = endpoint("server", serverTitle, {});
  serverTitle->setText("Relay 服务器");
  diagramServer = server->findChildren<QLabel *>().last();
  diagramServer->setWordWrap(true);
  dl->addWidget(server, 2);
  cl->addWidget(diagram);
  auto actions = new QWidget;
  actions->setObjectName("connectionActions");
  auto al = row(actions);
  al->setContentsMargins(24, 19, 24, 19);
  auto words = new QWidget;
  auto wl = column(words, 0, 4);
  connectionTitle = text({}, "h2");
  connectionHelp = text({}, "muted", true);
  wl->addWidget(connectionTitle);
  wl->addWidget(connectionHelp);
  al->addWidget(words, 1);
  connectButton = button("连接", "connect", "plug", true);
  disconnectButton = button("断开", "disconnect", "unplug");
  reconnectButton = button("重连", "reconnect", "refresh");
  for (auto b : {connectButton, disconnectButton, reconnectButton})
    al->addWidget(b);
  cl->addWidget(actions);
  connect(connectButton, &QPushButton::clicked, this,
          [this] { run("connect"); });
  connect(reconnectButton, &QPushButton::clicked, this,
          [this] { run("reconnect"); });
  connect(disconnectButton, &QPushButton::clicked, this,
          [this] { confirm("disconnect"); });
  metrics = new QFrame;
  auto ml = row(metrics, 15);
  layout->addWidget(metrics);
  auto metric = [&](QString caption, QLabel *&value, QLabel *&detail) {
    auto box = new QFrame;
    box->setProperty("card", true);
    auto l = column(box, 18, 7);
    l->addWidget(text(caption, "small"));
    value = text("—");
    value->setStyleSheet("font-size:23px;font-weight:600;");
    l->addWidget(value);
    detail = text({}, "small");
    l->addWidget(detail);
    ml->addWidget(box, 1);
  };
  metric("本机运行环境", runtimeValue, runtimeKind);
  QLabel *taskDetail, *threadDetail;
  metric("正在运行的任务", taskValue, taskDetail);
  taskDetail->setText("断开后继续执行");
  metric("已同步会话", threadValue, threadDetail);
  threadDetail->setText("来自本机 Codex 目录");
  loginCard = card(layout, "loginCard");
  auto ll = column(loginCard, 24, 18);
  auto sh = new QWidget;
  auto sl = row(sh);
  sl->addWidget(text("账号登录", "h2"), 1);
  sl->addWidget(text("不保存密码", "small"));
  ll->addWidget(sh);
  auto form = new QWidget;
  auto grid = new QGridLayout(form);
  grid->setContentsMargins(0, 0, 0, 0);
  grid->setSpacing(16);
  grid->setColumnStretch(0, 1);
  grid->setColumnStretch(1, 1);
  grid->addWidget(
      field("服务器地址", loginUrl, "loginUrl", "https://relay.example.com"), 0,
      0);
  grid->addWidget(field("设备名称", loginDevice, "loginDevice"), 0, 1);
  loginDevice->setMaxLength(200);
  grid->addWidget(field("账号", username, "username"), 1, 0);
  username->setMaxLength(100);
  grid->addWidget(field("密码", password, "password"), 1, 1);
  password->setMaxLength(128);
  password->setEchoMode(QLineEdit::Password);
  ll->addWidget(form);
  auto footer = new QWidget;
  auto fl = row(footer);
  fl->addWidget(text("会话失效后需要重新登录。", "small"), 1);
  loginButton = button("登录并连接", "login", "arrow", true);
  fl->addWidget(loginButton);
  ll->addWidget(footer);
  connect(loginUrl, &QLineEdit::textEdited, this,
          [this](QString v) { edit("relayUrl", v); });
  connect(loginDevice, &QLineEdit::textEdited, this,
          [this](QString v) { edit("deviceName", v); });
  connect(username, &QLineEdit::textEdited, this,
          [this](QString v) { edit("username", v); });
  connect(password, &QLineEdit::textChanged, this, [this] { controls(); });
  connect(loginButton, &QPushButton::clicked, this, [this] { login(); });
  for (auto edit : {loginUrl, loginDevice, username, password})
    connect(edit, &QLineEdit::returnPressed, this, [this] { login(); });
  accountCard = card(layout, "accountCard");
  auto acl = row(accountCard);
  acl->setContentsMargins(24, 22, 24, 22);
  auto account = new QWidget;
  auto accountLabels = column(account, 0, 4);
  accountName = text({}, "h2");
  expiry = text({}, "muted");
  accountLabels->addWidget(accountName);
  accountLabels->addWidget(expiry);
  acl->addWidget(account, 1);
  auto open = button("打开控制端", "openControl", "external");
  logoutButton = button("退出登录", "logout", "logout");
  acl->addWidget(open);
  acl->addWidget(logoutButton);
  connect(open, &QPushButton::clicked, this, [this] { run("openControl"); });
  connect(logoutButton, &QPushButton::clicked, this,
          [this] { confirm("logout"); });
  layout->addWidget(hint(
      "关闭窗口默认进入托盘。点击“断开”会暂停重连并停止接收新的远程指令。"));
  return page;
}

QWidget *ConnectorUi::settingsPage() {
  auto page = new QWidget;
  auto layout = column(page, 0, 18);
  auto upgrade = card(layout);
  auto ul = column(upgrade, 24, 12);
  auto uh = new QWidget;
  auto uhr = row(uh);
  uhr->addWidget(text("Agent 更新", "h2"), 1);
  updateCheck = button("检查更新", "updatesCheck");
  uhr->addWidget(updateCheck);
  ul->addWidget(uh);
  updateSummary = text("登录后从当前 Relay 检查更新", "muted", true);
  ul->addWidget(updateSummary);
  updateNotes = text({}, "muted", true);
  ul->addWidget(updateNotes);
  auto updateActions = new QWidget;
  auto ual = row(updateActions);
  updateDownload = button("下载更新", "updatesDownload", {}, true);
  updateCancel = button("取消下载", "updatesCancel");
  updateOpen = button("打开安装包", "updatesOpen", {}, true);
  for (auto b : {updateDownload, updateCancel, updateOpen})
    ual->addWidget(b);
  ual->addStretch();
  ul->addWidget(updateActions);
  updateError = text({}, "muted", true);
  ul->addWidget(updateError);
  ul->addWidget(
      text("下载不影响当前任务。安装前请等待本机任务完成，登录和设备配置保留。",
           "small", true));
  connect(updateCheck, &QPushButton::clicked, this,
          [this] { run("updates.check"); });
  connect(updateDownload, &QPushButton::clicked, this,
          [this] { run("updates.download"); });
  connect(updateCancel, &QPushButton::clicked, this,
          [this] { run("updates.cancel"); });
  connect(updateOpen, &QPushButton::clicked, this,
          [this] { run("updates.open"); });
  auto config = card(layout);
  auto configLayout = column(config, 24, 18);
  auto ch = new QWidget;
  auto chr = row(ch);
  chr->addWidget(text("设备与运行环境", "h2"), 1);
  chr->addWidget(text("修改后手动连接", "small"));
  configLayout->addWidget(ch);
  auto gridWidget = new QWidget;
  auto grid = new QGridLayout(gridWidget);
  grid->setContentsMargins(0, 0, 0, 0);
  grid->setSpacing(16);
  grid->setColumnStretch(0, 1);
  grid->setColumnStretch(1, 1);
  grid->addWidget(field("服务器地址", settingsUrl, "settingsUrl",
                        "https://relay.example.com"),
                  0, 0);
  grid->addWidget(field("设备名称", settingsDevice, "settingsDevice"), 0, 1);
  settingsDevice->setMaxLength(200);
  auto path = [&](QString caption, QString name, QString kind,
                  QLineEdit *&lineEdit) {
    auto w = field(caption, lineEdit, name);
    auto line = lineEdit;
    w->layout()->removeWidget(line);
    auto pathWidget = new QWidget;
    auto pl = row(pathWidget, 8);
    pl->addWidget(line, 1);
    auto browse = button({}, "pick" + kind, "folder");
    browse->setAccessibleName(caption == "Codex 数据目录" ? "选择数据目录"
                                                          : "选择程序");
    pl->addWidget(browse);
    w->layout()->addWidget(pathWidget);
    connect(browse, &QPushButton::clicked, this, [this, kind] {
      QString chosen = pick ? pick(kind) : QString();
      if (!chosen.isEmpty())
        edit(kind == "home" ? "codexHome" : "codexBinary", chosen);
    });
    return w;
  };
  grid->addWidget(path("Codex 数据目录", "codexHome", "home", home), 1, 0, 1,
                  2);
  grid->addWidget(path("Codex 程序路径", "codexBinary", "binary", binary), 2, 0,
                  1, 2);
  binary->setPlaceholderText("自动查找；找不到时选择程序");
  auto mode = new QWidget;
  auto modeLayout = column(mode, 0, 7);
  modeLayout->addWidget(text("运行方式", "label"));
  runtime = new QComboBox;
  runtime->setObjectName("runtime");
  runtime->addItem("自动 · 优先官方桌面", "auto");
  runtime->addItem("仅官方桌面 IPC", "desktop");
  runtime->addItem("仅官方 App Server", "headless");
  modeLayout->addWidget(runtime);
  grid->addWidget(mode, 3, 0);
  configLayout->addWidget(gridWidget);
  configLayout->addWidget(text("修改服务器地址或设备名称后需重新登录。有本机任"
                               "务运行时，运行配置暂不能修改。",
                               "small", true));
  for (auto pair : {qMakePair(settingsUrl, QString("relayUrl")),
                    qMakePair(settingsDevice, QString("deviceName")),
                    qMakePair(home, QString("codexHome")),
                    qMakePair(binary, QString("codexBinary"))})
    connect(pair.first, &QLineEdit::textEdited, this,
            [this, key = pair.second](QString value) { edit(key, value); });
  connect(runtime, qOverload<int>(&QComboBox::currentIndexChanged), this,
          [this] {
            if (!syncing)
              edit("runtime", runtime->currentData().toString());
          });
  auto parents = card(layout);
  auto parentLayout = column(parents, 24, 14);
  auto ph = new QWidget;
  auto phr = row(ph);
  phr->addWidget(text("新建项目的目录权限", "h2"), 1);
  addParentButton = button("添加父目录", "addParent", "folder");
  phr->addWidget(addParentButton);
  parentLayout->addWidget(ph);
  parentLayout->addWidget(text("远程端可以在这些目录及其子目录内新建或添加项目"
                               "。默认不授权；保存后重新连接生效。",
                               "small", true));
  auto rows = new QWidget;
  parentRows = column(rows, 0, 4);
  parentLayout->addWidget(rows);
  parentLayout->addWidget(text(
      "此权限只限制项目创建。Codex "
      "后续命令与文件操作由其执行权限控制。新会话使用工作区写入和按需审批。",
      "small", true));
  connect(addParentButton, &QPushButton::clicked, this, [this] {
    if (draft["projectParents"].toArray().size() >= 20)
      return;
    auto chosen = pick ? pick("project") : QString();
    auto paths = draft["projectParents"].toArray();
    if (!chosen.isEmpty() && !paths.contains(chosen)) {
      paths.append(chosen);
      edit("projectParents", paths);
    }
  });
  auto startup = card(layout);
  auto startupLayout = column(startup, 24, 0);
  title(startupLayout, "启动与后台");
  const QStringList keys{"openAtLogin", "autoConnect", "minimizeToTray",
                         "allowHttp"},
      captions{"开机启动", "启动后自动连接", "关闭窗口后留在后台",
               "允许远程 HTTP"},
      details{"登录系统后启动 Codexer Agent",
              "使用已保存且有效的账号会话连接服务器",
              "通过 Windows 托盘或 macOS 菜单栏打开控制台",
              "用于内网或测试；HTTP 会明文传输账号和任务，公网请使用 HTTPS"};
  for (int n = 0; n < 4; n++) {
    auto w = new QWidget;
    auto l = row(w);
    l->setContentsMargins(0, 15, 0, 15);
    auto labels = new QWidget;
    auto ll = column(labels, 0, 4);
    ll->addWidget(text(captions[n], "label"));
    ll->addWidget(text(details[n], "small", true));
    l->addWidget(labels, 1);
    auto toggle = new Toggle;
    toggle->setObjectName(keys[n]);
    toggle->setAccessibleName(captions[n]);
    l->addWidget(toggle);
    toggles[keys[n]] = toggle;
    connect(toggle, &QCheckBox::toggled, this,
            [this, key = keys[n]](bool checked) {
              if (!syncing)
                edit(key, checked);
            });
    startupLayout->addWidget(w);
  }
  auto save = new QWidget;
  auto saveLayout = row(save);
  saveStatus = text("设置已同步", "small");
  saveLayout->addWidget(saveStatus, 1);
  saveButton = button("保存设置", "save", "check", true);
  saveLayout->addWidget(saveButton);
  layout->addWidget(save);
  connect(saveButton, &QPushButton::clicked, this, [this] {
    run("save", draft, [this](QJsonValue, QString error) {
      if (error.isEmpty())
        showNote("设置已保存");
    });
  });
  return page;
}

QWidget *ConnectorUi::logsPage() {
  auto page = new QWidget;
  auto layout = column(page, 0, 18);
  auto checkCard = card(layout);
  auto checkLayout = column(checkCard, 24, 18);
  auto h = new QWidget;
  auto hl = row(h);
  hl->addWidget(text("运行检查", "h2"), 1);
  checkReconnect = button("重新连接", "checkReconnect", "refresh");
  hl->addWidget(checkReconnect);
  checkLayout->addWidget(h);
  connect(checkReconnect, &QPushButton::clicked, this,
          [this] { run("reconnect"); });
  auto grid = new QGridLayout;
  grid->setSpacing(18);
  int n = 0;
  for (const auto &caption : QStringList{"系统安全存储", "账号登录",
                                         "Relay 连接", "本机 Codex 运行环境"}) {
    auto label = text(caption, "label");
    checks.append(label);
    grid->addWidget(label, n / 2, n % 2);
    n++;
  }
  checkLayout->addLayout(grid);
  auto sessionCard = card(layout);
  auto sessionLayout = column(sessionCard, 24, 12);
  title(sessionLayout, "Codex 运行时与会话");
  sessionLayout->addWidget(
      text("空闲会话会自动释放。正在执行任务、等待审批或回复、有运行中子任务及"
           "尚未发送首条消息的会话会保留。",
           "small", true));
  auto actions = new QWidget;
  auto al = row(actions);
  refreshButton = button("刷新 Codex 运行时", "refreshRuntime", "refresh");
  releaseButton = button("释放空闲会话", "releaseSessions");
  al->addWidget(refreshButton);
  al->addWidget(releaseButton);
  al->addStretch();
  sessionLayout->addWidget(actions);
  connect(refreshButton, &QPushButton::clicked, this, [this] {
    run("refreshRuntime", {}, [this](QJsonValue value, QString error) {
      if (error.isEmpty())
        showNote(value.toObject()["runtimeRefresh"] == "deferred"
                     ? "运行时正在使用，已安排空闲后刷新"
                     : "已检查 Codex 运行时");
    });
  });
  connect(releaseButton, &QPushButton::clicked, this, [this] {
    run("releaseSessions", {}, [this](QJsonValue value, QString error) {
      if (error.isEmpty()) {
        auto r = value.toObject();
        showNote(QString("已释放 %1 个空闲会话；%2 个会话仍需等待。")
                     .arg(r["released"].toInt())
                     .arg(r["deferred"].toInt()));
      }
    });
  });
  auto logCard = card(layout);
  auto logLayout = column(logCard, 24, 14);
  auto lh = new QWidget;
  auto lhl = row(lh);
  lhl->addWidget(text("最近诊断", "h2"), 1);
  auto exportButton = button("导出诊断", "exportLogs", "download");
  lhl->addWidget(exportButton);
  logLayout->addWidget(lh);
  logLayout->addWidget(
      text("仅记录诊断代码，不包含服务器地址、密码、会话凭据或任务内容。",
           "small", true));
  logs = new QListWidget;
  logs->setObjectName("diagnosticLogs");
  logs->setItemDelegate(new LogRow(logs));
  logs->setStyleSheet(
      "QListWidget{border:0;background:white;}QListWidget::item{border:0;}");
  logs->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  logs->setUniformItemSizes(true);
  logs->setMaximumHeight(320);
  logs->setMinimumHeight(180);
  auto copy = new QAction("复制诊断", logs);
  copy->setShortcut(QKeySequence::Copy);
  copy->setShortcutContext(Qt::WidgetWithChildrenShortcut);
  logs->addAction(copy);
  logs->setContextMenuPolicy(Qt::ActionsContextMenu);
  connect(copy, &QAction::triggered, this, [this] {
    if (auto item = logs->currentItem())
      QApplication::clipboard()->setText(item->text());
  });
  logLayout->addWidget(logs);
  logsEmpty = text("暂无诊断记录", "muted");
  logLayout->addWidget(logsEmpty);
  connect(exportButton, &QPushButton::clicked, this, [this] {
    run("exportLogs", {}, [this](QJsonValue value, QString error) {
      if (error.isEmpty() && !value.toObject()["path"].toString().isEmpty())
        showNote("已导出脱敏诊断");
    });
  });
  return page;
}

void ConnectorUi::edit(const QString &key, QJsonValue value) {
  if (syncing)
    return;
  draft[key] = value;
  syncDraft();
  controls();
  if (key == "projectParents")
    rebuildParents();
}
void ConnectorUi::syncDraft() {
  syncing = true;
  auto set = [](QLineEdit *field, const QString &value) {
    if (field->text() != value) {
      const auto cursor = field->cursorPosition();
      field->setText(value);
      if (field->hasFocus())
        field->setCursorPosition(qMin(cursor, value.size()));
    }
  };
  for (auto pair : {qMakePair(loginUrl, QString("relayUrl")),
                    qMakePair(settingsUrl, QString("relayUrl")),
                    qMakePair(loginDevice, QString("deviceName")),
                    qMakePair(settingsDevice, QString("deviceName")),
                    qMakePair(username, QString("username")),
                    qMakePair(home, QString("codexHome")),
                    qMakePair(binary, QString("codexBinary"))})
    set(pair.first, draft[pair.second].toString());
  runtime->setCurrentIndex(
      qMax(0, runtime->findData(draft["runtime"].toString())));
  for (auto it = toggles.begin(); it != toggles.end(); ++it)
    it.value()->setChecked(draft[it.key()].toBool());
  syncing = false;
}
void ConnectorUi::rebuildParents() {
  while (auto item = parentRows->takeAt(0)) {
    delete item->widget();
    delete item;
  }
  auto paths = draft["projectParents"].toArray();
  if (paths.isEmpty())
    parentRows->addWidget(
        text("尚未授权目录，远程端无法新建项目。", "small", true));
  for (const auto &entry : paths) {
    auto path = entry.toString();
    auto w = new QWidget;
    auto l = row(w, 12);
    auto glyph = new QLabel;
    glyph->setPixmap(icon("folder").pixmap(17, 17));
    l->addWidget(glyph);
    auto label = text(path, "label", true);
    label->setTextInteractionFlags(Qt::TextSelectableByMouse);
    l->addWidget(label, 1);
    auto remove = button({}, "removeParent", "close");
    remove->setAccessibleName("移除授权 " + path);
    remove->setEnabled(!busy());
    l->addWidget(remove);
    connect(remove, &QPushButton::clicked, this, [this, path] {
      QJsonArray values;
      for (auto v : draft["projectParents"].toArray())
        if (v.toString() != path)
          values.append(v);
      edit("projectParents", values);
    });
    parentRows->addWidget(w);
  }
  relayout();
}
void ConnectorUi::controls() {
  const bool enabled = !busy(), logged = state["loggedIn"].toBool();
  const auto phase = state["phase"].toString();
  loginButton->setEnabled(enabled && state["secureStorage"].toBool() &&
                          !password->text().isEmpty() &&
                          !draft["username"].toString().trimmed().isEmpty() &&
                          !draft["relayUrl"].toString().trimmed().isEmpty() &&
                          !draft["deviceName"].toString().trimmed().isEmpty());
  loginButton->setText(busy() ? "正在处理…" : "登录并连接");
  connectButton->setVisible(logged && phase == "disconnected");
  disconnectButton->setVisible(logged && phase != "disconnected");
  reconnectButton->setVisible(logged);
  for (auto b :
       {connectButton, disconnectButton, reconnectButton, logoutButton})
    b->setEnabled(enabled && logged);
  saveButton->setEnabled(enabled && dirty());
  saveStatus->setText(dirty() ? "有未保存的设置" : "设置已同步");
  addParentButton->setEnabled(enabled &&
                              draft["projectParents"].toArray().size() < 20);
  for (auto b : findChildren<QPushButton *>("removeParent"))
    b->setEnabled(enabled);
  checkReconnect->setEnabled(enabled && logged);
  refreshButton->setEnabled(enabled && logged && !state["status"].isNull());
  releaseButton->setEnabled(enabled && logged && !state["status"].isNull());
}
void ConnectorUi::applyState(const QJsonObject &value) {
  state = value;
  const auto incoming = value["settings"].toObject();
  if (saved != incoming) {
    saved = incoming;
    draft = incoming;
    syncDraft();
    rebuildParents();
  }
  const bool connected = value["phase"] == "connected",
             logged = value["loggedIn"].toBool();
  const auto status = value["status"].toObject();
  const auto phase = value["phase"].toString();
  badge->setText("●  " + phaseLabel(phase));
  badge->setProperty("connected", connected);
  badge->style()->unpolish(badge);
  badge->style()->polish(badge);
  version->setText("Codexer Agent " + value["version"].toString());
  diagramDevice->setText(saved["deviceName"].toString());
  diagramServer->setText(saved["relayUrl"].toString().isEmpty()
                             ? "尚未配置"
                             : saved["relayUrl"].toString());
  diagramServer->setToolTip(saved["relayUrl"].toString());
  linkStatus->setText("· · · ·  " + phaseLabel(phase) + "  · · · ·");
  connectionTitle->setText(connected                 ? "远程连接已就绪"
                           : phase == "signed-out"   ? "登录账号，连接这台电脑"
                           : phase == "disconnected" ? "远程连接已暂停"
                                                     : "正在建立远程连接");
  connectionHelp->setText(connected ? "使用同一账号在控制端选择这台电脑。"
                          : phase == "disconnected"
                              ? "本机任务会继续运行，连接后恢复远程控制。"
                              : "连接器需要本机已安装并登录官方 Codex。");
  const bool hasStatus = value["status"].isObject();
  metrics->setVisible(logged || hasStatus);
  loginCard->setVisible(!logged);
  accountCard->setVisible(logged);
  securityNotice->setVisible(!value["secureStorage"].toBool());
  runtimeValue->setText(status["runtimeConnected"].toBool() ? "可用"
                                                            : "等待接入");
  runtimeKind->setText(
      status["runtime"] == "official-desktop-ipc"  ? "官方桌面 IPC"
      : status["runtime"] == "official-app-server" ? "官方 App Server"
                                                   : "连接后检查");
  taskValue->setText(
      hasStatus ? QString::number(status["activeTasks"].toInt()) + " 个" : "—");
  threadValue->setText(
      hasStatus ? QString::number(status["threads"].toInt()) + " 个" : "—");
  accountName->setText("当前账号 · " + saved["username"].toString());
  expiry->setText("会话有效期至 " + timeText(value["expiresAt"], true));
  footerDevice->setText("●  " + saved["deviceName"].toString());
  footerTime->setText(hasStatus ? "更新于 " + timeText(status["updatedAt"])
                                : "本机服务尚未启动");
  const QList<bool> ready{value["secureStorage"].toBool(), logged, connected,
                          status["runtimeConnected"].toBool()};
  const QStringList captions{"系统安全存储", "账号登录", "Relay 连接",
                             "本机 Codex 运行环境"};
  for (int n = 0; n < 4; n++)
    checks[n]->setText((ready[n] ? "✓  " : "○  ") + captions[n] +
                       (ready[n] ? "    通过" : "    等待或需要检查"));
  if (selected == 2 && lastLogs != value["logs"].toArray()) {
    lastLogs = value["logs"].toArray();
    logs->clear();
    for (auto it = lastLogs.constEnd(); it != lastLogs.constBegin();) {
      const auto entry = (--it)->toObject();
      const auto code = entry["code"].toString();
      logs->addItem(timeText(entry["at"]) + "\n" + diagnostic(code) + "\n" +
                    code);
    }
    logsEmpty->setVisible(lastLogs.isEmpty());
  }
  if (!value["error"].toString().isEmpty())
    showError(value["error"].toString());
  controls();
  relayout();
}
void ConnectorUi::applyUpdate(const QJsonObject &value) {
  updates = value;
  auto release = value["release"].toObject();
  const bool available = value["available"].toBool(),
             downloading = value["downloading"].toBool(),
             downloaded = value["downloaded"].toBool();
  QString summary = "当前版本 " + value["version"].toString("—");
  summary += available ? " · 新版本 " + release["version"].toString()
             : !value["error"].toString().isEmpty() ? " · 检查暂不可用"
             : value["checkedAt"].isDouble()        ? " · 已是最新版本"
                                             : " · 登录后从当前 Relay 检查更新";
  updateSummary->setText(summary);
  updateNotes->setText(release["notes"].toString());
  updateNotes->setVisible(!release["notes"].toString().isEmpty());
  updateError->setText(value["error"].toString());
  updateError->setVisible(!value["error"].toString().isEmpty());
  updateCheck->setEnabled(!downloading && !value["checking"].toBool());
  updateDownload->setVisible(available && !downloaded);
  updateDownload->setEnabled(!downloading);
  updateDownload->setText(
      downloading
          ? QString("下载中 %1%").arg(int(value["progress"].toDouble() * 100))
          : "下载更新");
  updateCancel->setVisible(downloading);
  updateOpen->setVisible(available && downloaded);
  updateOpen->setText(release["target"] == "agent-windows-x64-portable"
                          ? "打开更新文件位置"
                          : "打开安装包");
  relayout();
}
void ConnectorUi::showError(const QString &value) {
  noticeText->setText(value);
  notice->setProperty("success", false);
  notice->style()->unpolish(notice);
  notice->style()->polish(notice);
  notice->setVisible(!value.isEmpty());
}
void ConnectorUi::showNote(const QString &value) {
  noticeText->setText(value);
  notice->setProperty("success", true);
  notice->style()->unpolish(notice);
  notice->style()->polish(notice);
  notice->setVisible(!value.isEmpty());
}
void ConnectorUi::run(QString method, QJsonObject value, Done done) {
  showError({});
  if (!command) {
    showError("本机服务尚未就绪");
    return;
  }
  command(method, value, [this, done](QJsonValue result, QString error) {
    if (!error.isEmpty())
      showError(error);
    if (done)
      done(result, error);
  });
}
void ConnectorUi::login() {
  if (!loginButton->isEnabled() || pending)
    return;
  const auto secret = password->text(), name = draft["username"].toString();
  password->clear();
  pending = true;
  controls();
  auto send = [this, name, secret] {
    run("login", {{"username", name}, {"password", secret}},
        [this](QJsonValue, QString) {
          pending = false;
          controls();
        });
  };
  if (dirty())
    run("save", draft, [this, send](QJsonValue, QString error) {
      if (error.isEmpty())
        send();
      else {
        pending = false;
        controls();
      }
    });
  else
    send();
}
void ConnectorUi::confirm(const QString &action) {
  if (findChild<QDialog *>("confirmation"))
    return;
  auto backdrop = new QWidget(this);
  backdrop->setObjectName("confirmationBackdrop");
  backdrop->setGeometry(rect().adjusted(0, 46, 0, 0));
  backdrop->setStyleSheet("background:rgba(21,35,60,102);");
  backdrop->show();
  backdrop->raise();
  auto dialog = new QDialog(this, Qt::Dialog | Qt::FramelessWindowHint);
  dialog->setObjectName("confirmation");
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setModal(true);
  dialog->setFixedWidth(450);
  auto layout = column(dialog, 32, 16);
  connect(dialog, &QDialog::finished, backdrop, &QObject::deleteLater);
  auto h = new QWidget;
  auto hl = row(h);
  hl->addWidget(
      text(action == "logout" ? "退出账号登录？" : "断开远程连接？", "h2"), 1);
  auto close = button({}, "cancelClose", "close");
  hl->addWidget(close);
  layout->addWidget(h);
  layout->addWidget(text("暂停自动重连并停止接收新的远程指令。已经开始的本机任"
                         "务会继续运行，待发送消息暂停执行。",
                         "muted", true));
  if (action == "logout")
    layout->addWidget(
        text("本机保存的账号会话将被清除，再次连接需要登录。", "muted", true));
  auto buttons = new QWidget;
  auto bl = row(buttons);
  bl->addStretch();
  auto cancel = button("取消", "cancelConfirmation"),
       yes = button(action == "logout" ? "退出登录" : "断开连接",
                    "confirmAction", {}, true);
  bl->addWidget(cancel);
  bl->addWidget(yes);
  layout->addWidget(buttons);
  connect(cancel, &QPushButton::clicked, dialog, &QDialog::reject);
  cancel->setDefault(true);
  connect(close, &QPushButton::clicked, dialog, &QDialog::reject);
  connect(yes, &QPushButton::clicked, this, [this, dialog, action] {
    dialog->accept();
    run(action);
  });
  dialog->adjustSize();
  dialog->move(window()->frameGeometry().center() - dialog->rect().center());
  dialog->open();
  cancel->setFocus();
}
void ConnectorUi::relayout() {
  QTimer::singleShot(0, this, [this] {
    auto page = pages->currentWidget();
    const auto width = pages->width();
    int height = page->hasHeightForWidth() ? page->heightForWidth(width)
                                           : page->sizeHint().height();
    if (page->layout()->hasHeightForWidth())
      height = page->layout()->heightForWidth(width);
    pages->setFixedHeight(qMax(height, 100));
  });
}
void ConnectorUi::selectPage(int page) {
  selected = qBound(0, page, 2);
  pages->setCurrentIndex(selected);
  for (int n = 0; n < 3; n++)
    navigation[n]->setChecked(n == selected);
  const QStringList captions{"连接状态", "设置", "诊断日志"},
      subtitles{"让控制端安全连接到这台电脑", "配置设备和后台运行方式",
                "检查连接情况，导出可分享的脱敏诊断"};
  heading->setText(captions[selected]);
  subtitle->setText(subtitles[selected]);
  scroll->verticalScrollBar()->setValue(0);
  if (selected == 2 && !state.isEmpty())
    applyState(state);
  relayout();
}
bool ConnectorUi::eventFilter(QObject *object, QEvent *event) {
  if (object->objectName() == "titlebar") {
    if (event->type() == QEvent::MouseButtonDblClick) {
      window()->isMaximized() ? window()->showNormal()
                              : window()->showMaximized();
      return true;
    }
    if (event->type() == QEvent::MouseButtonPress &&
        static_cast<QMouseEvent *>(event)->button() == Qt::LeftButton) {
      if (window()->windowHandle())
        window()->windowHandle()->startSystemMove();
      return true;
    }
  }
  if (object == window()) {
    if (event->type() == QEvent::Resize) {
      sidebar->setFixedWidth(window()->width() <= 1020 ? 195 : 216);
      auto content = scroll->widget();
      content->layout()->setContentsMargins(window()->width() <= 1020 ? 24 : 38,
                                            window()->width() <= 1020 ? 25 : 30,
                                            window()->width() <= 1020 ? 24 : 38,
                                            0);
      relayout();
    }
    if (event->type() == QEvent::WindowStateChange) {
      auto maximize = findChild<QPushButton *>("maximize");
      maximize->setIcon(icon(window()->isMaximized() ? "restore" : "maximize"));
      maximize->setAccessibleName(window()->isMaximized() ? "还原窗口"
                                                          : "最大化");
    }
  }
  return QWidget::eventFilter(object, event);
}
