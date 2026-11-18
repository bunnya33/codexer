import ExpoModulesCore
import UIKit

@MainActor private func messageHaptic() {
  UIImpactFeedbackGenerator(style: .light).impactOccurred()
}

public class CodexerMessagesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CodexerMessages")
    Function("haptic") { DispatchQueue.main.async { messageHaptic() } }
    View(CodexerMessageTextView.self) {
      Events("onContentHeight", "onAction", "onSelection")
      Prop("runs") { (view, value: [[String: Any]]) in view.updateRuns(value) }
      Prop("textColor") { (view, value: String) in view.ink = value; view.render() }
      Prop("linkColor") { (view, value: String) in view.accent = value; view.render() }
      Prop("bubbleColor") { (_: CodexerMessageTextView, _: String) in }
      Prop("userMessage") { (view, value: Bool) in view.userMessage = value }
      Prop("menuTitle") { (view, value: String) in view.menuTitle = value }
      Prop("canEdit") { (view, value: Bool) in view.canEdit = value }
      Prop("codeBlock") { (view, value: Bool) in view.codeBlock = value; view.render() }
      Prop("selectionRequest") { (view, value: Int) in if value > view.selectionRequest { view.selectionRequest = value; view.selectMessage() } }
      Prop("dismissSelectionRequest") { (view, value: Int) in
        if value > view.dismissSelectionRequest { view.dismissSelectionRequest = value; view.dismissSelection() }
      }
    }
  }
}

final class MessageSelectionTextView: UITextView {
  var copied: (() -> Void)?
  override func copy(_ sender: Any?) {
    let previous = UIPasteboard.general.changeCount
    super.copy(sender)
    if UIPasteboard.general.changeCount != previous {
      messageHaptic()
      copied?()
    }
  }
}

final class CodexerMessageTextView: ExpoView, UITextViewDelegate, UIContextMenuInteractionDelegate {
  let onContentHeight = EventDispatcher(), onAction = EventDispatcher(), onSelection = EventDispatcher()
  let textView = MessageSelectionTextView()
  var runs: [[String: Any]] = [], ink = "#222222", accent = "#346bdf"
  var userMessage = false {
    didSet {
      guard userMessage != oldValue else { return }
      textView.isSelectable = !userMessage || selecting
      if userMessage { addInteraction(messageMenu) } else { removeInteraction(messageMenu) }
    }
  }
  var canEdit = false, menuTitle = "", selectionRequest = 0
  var dismissSelectionRequest = 0
  var codeBlock = false
  private lazy var messageMenu = UIContextMenuInteraction(delegate: self)
  private var selecting = false, measured: CGFloat = 0, naturalWidth: CGFloat = 0
  private var menuVisible = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.delegate = self
    textView.copied = { [weak self] in self?.onAction(["action": "copied"]) }
    textView.adjustsFontForContentSizeCategory = true
    addSubview(textView)
    let linkTap = UITapGestureRecognizer(target: self, action: #selector(openUserLink(_:)))
    linkTap.cancelsTouchesInView = false
    addGestureRecognizer(linkTap)
  }
  func updateRuns(_ value: [[String: Any]]) {
    guard !NSDictionary(dictionary: ["runs": runs]).isEqual(to: ["runs": value]) else { return }
    runs = value
    // A selection is a stable reading surface while streamed text changes.
    if !selecting && !menuVisible { render() }
  }
  func render() {
    guard !selecting && !menuVisible else { return }
    let result = NSMutableAttributedString(string: "")
    for run in runs {
      let heading = run["heading"] as? Int ?? 0
      var traits: UIFontDescriptor.SymbolicTraits = []
      if run["bold"] as? Bool == true || heading > 0 { traits.insert(.traitBold) }
      if run["italic"] as? Bool == true { traits.insert(.traitItalic) }
      let size: CGFloat = heading == 1 ? 20 : heading == 2 ? 18 : 16
      let base = codeBlock || run["code"] as? Bool == true ? UIFont.monospacedSystemFont(ofSize: codeBlock ? 12 : 14, weight: .regular) : UIFont.systemFont(ofSize: size)
      let font = base.fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: base.pointSize) } ?? base
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = codeBlock ? 18 : 26
      var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Self.color(run["color"] as? String ?? ink), .paragraphStyle: paragraph]
      if run["paragraphBreak"] as? Bool == true {
        paragraph.minimumLineHeight = 8; paragraph.maximumLineHeight = 8
        attributes[.font] = UIFont.systemFont(ofSize: 6)
      }
      if run["strike"] as? Bool == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if run["code"] as? Bool == true { attributes[.backgroundColor] = UIColor.gray.withAlphaComponent(0.12) }
      if let link = run["link"] as? String, let url = URL(string: link) { attributes[.link] = url }
      result.append(NSAttributedString(string: run["text"] as? String ?? "", attributes: attributes))
    }
    textView.attributedText = result
    textView.linkTextAttributes = [.foregroundColor: Self.color(accent)]
    textView.tintColor = Self.color(accent)
    setNeedsLayout()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0 else { return }
    let height = ceil(textView.sizeThatFits(CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude)).height)
    let width = ceil(textView.attributedText.boundingRect(with: CGSize(width: 10000, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width) + 2
    textView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: height)
    if abs(height - measured) > 0.5 || abs(width - naturalWidth) > 0.5 {
      measured = height; naturalWidth = width
      onContentHeight(["height": height, "naturalWidth": width])
    }
  }
  func textViewDidChangeSelection(_ textView: UITextView) {
    let active = textView.selectedRange.length > 0
    guard active != selecting else { return }
    selecting = active
    onSelection(["active": active])
    if !active { render(); if userMessage { textView.isSelectable = false } }
  }
  func dismissSelection() {
    guard selecting else { return }
    textView.selectedRange = NSRange(location: textView.selectedRange.location, length: 0)
    textView.resignFirstResponder()
    textViewDidChangeSelection(textView)
  }
  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    if interaction == .invokeDefaultAction { onAction(["action": "link", "href": URL.absoluteString]) }
    return false
  }
  @objc private func openUserLink(_ recognizer: UITapGestureRecognizer) {
    guard userMessage && !selecting else { return }
    let point = recognizer.location(in: textView)
    let manager = textView.layoutManager
    let glyph = manager.glyphIndex(for: point, in: textView.textContainer)
    guard glyph < manager.numberOfGlyphs,
      manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textView.textContainer).contains(point) else { return }
    let index = manager.characterIndexForGlyph(at: glyph)
    if index < textView.attributedText.length,
       let url = textView.attributedText.attribute(.link, at: index, effectiveRange: nil) as? URL {
      onAction(["action": "link", "href": url.absoluteString])
    }
  }
  func selectMessage() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.textView.isSelectable = true
      self.textView.becomeFirstResponder()
      self.textView.selectAll(nil)
    }
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard userMessage && !selecting else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      let action: (String, String, String) -> UIAction = { title, icon, name in UIAction(title: title, image: UIImage(systemName: icon)) { [weak self] _ in self?.onAction(["action": name]) } }
      var actions = [action("复制", "doc.on.doc", "copy")]
      if self.canEdit { actions.append(action("编辑", "pencil", "edit")) }
      actions.append(UIAction(title: "选择文本", image: UIImage(systemName: "text.cursor")) { [weak self] _ in self?.selectMessage() })
      actions.append(action("分享提示", "square.and.arrow.up", "share"))
      return UIMenu(title: self.menuTitle, children: actions)
    }
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    guard let window else { return nil }
    let dark = traitCollection.userInterfaceStyle == .dark
    let bubble = UIView(frame: CGRect(x: 0, y: 0, width: bounds.width + 30, height: bounds.height + 22))
    bubble.backgroundColor = Self.color(dark ? "#24304d" : "#f0f4ff")
    bubble.layer.cornerRadius = 24
    let previewText = UITextView(frame: CGRect(x: 15, y: 11, width: bounds.width, height: bounds.height))
    previewText.backgroundColor = .clear
    previewText.isEditable = false; previewText.isSelectable = false; previewText.isScrollEnabled = false
    previewText.textContainerInset = .zero; previewText.textContainer.lineFragmentPadding = 0
    let attributed = NSMutableAttributedString(attributedString: textView.attributedText)
    attributed.addAttribute(.foregroundColor, value: Self.color(dark ? "#adc4ff" : "#274dab"), range: NSRange(location: 0, length: attributed.length))
    previewText.attributedText = attributed
    bubble.addSubview(previewText)
    let parameters = UIPreviewParameters(); parameters.backgroundColor = .clear
    parameters.visiblePath = UIBezierPath(roundedRect: bubble.bounds, cornerRadius: 24)
    let target = UIPreviewTarget(container: window, center: convert(CGPoint(x: bounds.midX, y: bounds.midY), to: window))
    return UITargetedPreview(view: bubble, parameters: parameters, target: target)
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    menuVisible = true
    onSelection(["active": true])
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    let finish = { [weak self] in
      guard let self else { return }
      self.menuVisible = false
      self.onSelection(["active": self.selecting])
      self.render()
    }
    if let animator { animator.addCompletion(finish) } else { finish() }
  }
  private static func color(_ value: String) -> UIColor {
    let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard let number = UInt64(hex, radix: 16) else { return .label }
    return UIColor(red: CGFloat((number >> 16) & 255)/255, green: CGFloat((number >> 8) & 255)/255, blue: CGFloat(number & 255)/255, alpha: 1)
  }
}
