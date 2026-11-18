package expo.modules.codexermessages

import android.app.Dialog
import android.content.Context
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Bundle
import android.text.Layout
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.*
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.LinearLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

class CodexerMessagesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodexerMessages")
    Function("haptic") { appContext.currentActivity?.runOnUiThread { appContext.currentActivity?.window?.decorView?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) } }
    View(CodexerMessageTextView::class) {
      Events("onContentHeight", "onAction", "onSelection")
      Prop("runs") { view: CodexerMessageTextView, value: List<Map<String, Any?>> -> if(view.runs != value) {view.runs=value;view.render()} }
      Prop("textColor") { view: CodexerMessageTextView, value: String -> view.text.setTextColor(Color.parseColor(value)) }
      Prop("linkColor") { view: CodexerMessageTextView, value: String -> view.setAccent(Color.parseColor(value)) }
      Prop("bubbleColor") { view: CodexerMessageTextView, value: String -> view.bubbleColor=Color.parseColor(value) }
      Prop("userMessage") { view: CodexerMessageTextView, value: Boolean -> view.userMessage=value }
      Prop("menuTitle") { view: CodexerMessageTextView, value: String -> view.menuTitle=value }
      Prop("canEdit") { view: CodexerMessageTextView, value: Boolean -> view.canEdit=value }
      Prop("codeBlock") { view: CodexerMessageTextView, value: Boolean -> view.setCodeBlock(value) }
      Prop("selectionRequest") { view: CodexerMessageTextView, value: Int -> if(value>view.selectionRequest){view.selectionRequest=value;view.selectMessage()} }
    }
  }
}

class CodexerMessageTextView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  val onContentHeight by EventDispatcher()
  val onAction by EventDispatcher()
  val onSelection by EventDispatcher()
  private val density = resources.displayMetrics.density
  private var selecting=false
  private val clipboard=context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  private var copyListener:ClipboardManager.OnPrimaryClipChangedListener?=null
  private val copyTimeout=Runnable{stopCopyWatch()}
  val text=object: TextView(context) {
    override fun onTextContextMenuItem(id:Int):Boolean {
      if(id!=android.R.id.copy)return super.onTextContextMenuItem(id)
      val start=min(selectionStart,selectionEnd).coerceAtLeast(0)
      val end=max(selectionStart,selectionEnd).coerceIn(start,text.length)
      watchCopy(text.subSequence(start,end).toString())
      val handled=super.onTextContextMenuItem(id)
      if(!handled)stopCopyWatch()
      post{clearFocus()}
      return handled
    }
    private fun watchCopy(expected:String){
      stopCopyWatch()
      // TextView returns true even when the system clipboard rejects a write.
      // Only the actual clipboard change can produce success feedback.
      copyListener=ClipboardManager.OnPrimaryClipChangedListener{
        val clip=clipboard.primaryClip
        if(clip!=null && clip.itemCount>0 && clip.getItemAt(0).coerceToText(context).toString()==expected){
          stopCopyWatch()
          performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          onAction(mapOf("action" to "copied"))
        }
      }
      clipboard.addPrimaryClipChangedListener(copyListener)
      postDelayed(copyTimeout,1000)
    }
    override fun onTouchEvent(event:MotionEvent):Boolean {
      if(selecting && event.actionMasked==MotionEvent.ACTION_DOWN) parent.requestDisallowInterceptTouchEvent(true)
      if(event.action==MotionEvent.ACTION_UP && !selecting){
        val layout=layout
        if(layout!=null){
          val x=event.x-totalPaddingLeft+scrollX
          val y=event.y-totalPaddingTop+scrollY
          val line=layout.getLineForVertical(y.toInt())
          val offset=layout.getOffsetForHorizontal(line,x)
          val span=(text as? Spanned)?.getSpans(offset,offset,ClickableSpan::class.java)?.firstOrNull()
          if(span!=null && x>=layout.getLineLeft(line) && x<=layout.getLineRight(line)) {span.onClick(this);return true}
        }
      }
      return super.onTouchEvent(event)
    }
  }
  var runs:List<Map<String,Any?>> = emptyList()
  var userMessage=false
  var canEdit=false
  var menuTitle=""
  var bubbleColor=Color.rgb(242,242,242)
  var selectionRequest=0
  private var reportedHeight=0
  private var reportedWidth=0
  private var menu:Dialog?=null
  private var codeBlock=false
  init {
    addView(text)
    text.setPadding(0,0,0,0)
    text.includeFontPadding=false
    text.textSize=16f
    text.setLineSpacing(5*density,1f)
    text.setTextIsSelectable(true)
    text.setOnLongClickListener {
      if(userMessage && !selecting){showMenu();true}else false
    }
    text.customSelectionActionModeCallback=object:ActionMode.Callback {
      override fun onCreateActionMode(mode:ActionMode,menu:Menu):Boolean {
        selecting=true
        parent?.requestDisallowInterceptTouchEvent(true)
        onSelection(mapOf("active" to true))
        return true
      }
      override fun onPrepareActionMode(mode:ActionMode,menu:Menu)=false
      override fun onActionItemClicked(mode:ActionMode,item:MenuItem)=false
      override fun onDestroyActionMode(mode:ActionMode){selecting=false;onSelection(mapOf("active" to false));text.post{if(!selecting)render()}}
    }
  }
  private fun dp(value:Int)=(value*density).toInt()
  fun setCodeBlock(value:Boolean){
    if(codeBlock==value)return
    codeBlock=value
    text.typeface=if(value)Typeface.MONOSPACE else Typeface.DEFAULT
    text.textSize=if(value)12f else 16f
    text.setLineSpacing((if(value)3 else 5)*density,1f)
    render()
  }
  private fun stopCopyWatch(){
    copyListener?.let{clipboard.removePrimaryClipChangedListener(it)}
    copyListener=null
    text.removeCallbacks(copyTimeout)
  }
  fun setAccent(color:Int){
    text.setLinkTextColor(color)
    text.highlightColor=Color.argb(65,Color.red(color),Color.green(color),Color.blue(color))
    if(Build.VERSION.SDK_INT>=29){
      text.textSelectHandleLeft?.mutate()?.setTint(color)
      text.textSelectHandleRight?.mutate()?.setTint(color)
      text.textSelectHandle?.mutate()?.setTint(color)
    }
  }
  fun selectMessage(){
    if(text.text.isEmpty())return
    selecting=true
    onSelection(mapOf("active" to true))
    text.post {
      // The public selection action starts the native toolbar and handles;
      // performLongClick alone leaves Android waiting for a touch release.
      (text.text as? Spannable)?.let{android.text.Selection.removeSelection(it)}
      val selection=Bundle().apply{
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT,0)
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,text.length())
      }
      if(!text.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_SELECTION,selection)){
        selecting=false;onSelection(mapOf("active" to false))
      }
    }
  }
  fun render(){
    if(selecting)return
    val result=SpannableStringBuilder()
    for(run in runs){
      val start=result.length
      result.append(run["text"] as? String ?: "")
      val end=result.length
      if(start==end)continue
      if(run["paragraphBreak"]==true)result.setSpan(AbsoluteSizeSpan(6,true),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val heading=(run["heading"] as? Number)?.toInt() ?: 0
      var style=if(run["bold"]==true||heading>0)Typeface.BOLD else Typeface.NORMAL
      if(run["italic"]==true)style=style or Typeface.ITALIC
      if(style!=Typeface.NORMAL)result.setSpan(StyleSpan(style),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if(run["strike"]==true)result.setSpan(StrikethroughSpan(),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if(run["code"]==true)result.setSpan(TypefaceSpan("monospace"),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if(heading in 1..2)result.setSpan(RelativeSizeSpan(if(heading==1)1.25f else 1.125f),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val link=run["link"] as? String
      (run["color"] as? String)?.let{color ->
        if(link==null)result.setSpan(ForegroundColorSpan(Color.parseColor(color)),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      if(link!=null)result.setSpan(object:ClickableSpan(){override fun onClick(widget:View){onAction(mapOf("action" to "link","href" to link))}},start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    text.text=result
    requestLayout()
    // Props may change without a Yoga size change; Android still needs a pass.
    post { if(width>0)measureText(width) }
  }
  private fun measureText(width:Int){
    text.measure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
    text.layout(0,0,width,text.measuredHeight)
    val natural=ceil(Layout.getDesiredWidth(text.text,text.paint).toDouble()).toInt()+dp(2)
    if(reportedHeight!=text.measuredHeight||reportedWidth!=natural){
      reportedHeight=text.measuredHeight;reportedWidth=natural
      onContentHeight(mapOf("height" to reportedHeight/density,"naturalWidth" to natural/density))
    }
  }
  override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){if(r>l)measureText(r-l)}
  override fun onDetachedFromWindow(){stopCopyWatch();menu?.dismiss();menu=null;super.onDetachedFromWindow()}
  private fun showMenu(){
    val activity=appContext.currentActivity ?: return
    if(menu!=null || !isAttachedToWindow)return
    onSelection(mapOf("active" to true))
    val dialog=Dialog(activity)
    val screen=resources.displayMetrics
    val location=IntArray(2);getLocationOnScreen(location)
    val root=android.widget.FrameLayout(activity)
    root.setOnClickListener{dialog.dismiss()}
    val dark=Color.red(text.currentTextColor)+Color.green(text.currentTextColor)+Color.blue(text.currentTextColor)>540
    val ink=if(dark)Color.rgb(242,242,246) else Color.rgb(24,24,26)
    val surface=if(dark)Color.argb(250,43,43,46) else Color.argb(250,244,243,246)
    val muted=if(dark)Color.rgb(160,160,168) else Color.rgb(139,139,144)
    val separator=if(dark)Color.argb(55,255,255,255) else Color.argb(25,0,0,0)
    val panelWidth=min(dp(240),screen.widthPixels-dp(32))
    val previewWidth=min(width+dp(30),screen.widthPixels-dp(32))
    val preview=TextView(activity).apply{
      text=this@CodexerMessageTextView.text.text
      textSize=16f;setTextColor(if(dark)Color.rgb(173,196,255) else Color.rgb(39,77,171))
      includeFontPadding=false;setLineSpacing(5*density,1f)
      setPadding(dp(15),dp(11),dp(15),dp(11))
      background=GradientDrawable().apply{setColor(if(dark)Color.rgb(36,48,77) else Color.rgb(240,244,255));cornerRadius=dp(24).toFloat()}
      maxLines=min(8,max(1,(screen.heightPixels/density*.22f/24).toInt()))
      elevation=dp(6).toFloat()
      setOnClickListener{dialog.dismiss()}
    }
    val rows=LinearLayout(activity).apply{
      orientation=LinearLayout.VERTICAL
      background=GradientDrawable().apply{setColor(surface);cornerRadius=dp(13).toFloat()}
      clipToOutline=true
      elevation=dp(2).toFloat()
    }
    fun divider(){rows.addView(View(activity).apply{setBackgroundColor(separator)},LinearLayout.LayoutParams(-1,max(1,dp(1)/2)))}
    if(menuTitle.isNotEmpty()){
      rows.addView(TextView(activity).apply{text=menuTitle;textSize=12f;setTextColor(muted);gravity=Gravity.CENTER_VERTICAL;setPadding(dp(15),0,dp(15),0)},LinearLayout.LayoutParams(-1,dp(32)))
      divider()
    }
    val actions=mutableListOf("复制" to "copy")
    if(canEdit)actions.add("编辑" to "edit")
    actions.add("选择文本" to "select");actions.add("分享提示" to "share")
    for((index,entry) in actions.withIndex()){
      val(title,action)=entry
      if(index>0)divider()
      rows.addView(TextView(activity).apply{
        text=title;textSize=16f;setTextColor(ink);gravity=Gravity.CENTER_VERTICAL;includeFontPadding=false
        setPadding(dp(15),0,dp(17),0)
        val icon=MessageMenuIcon(action,ink).apply{setBounds(0,0,dp(20),dp(20))}
        setCompoundDrawables(null,null,icon,null)
        compoundDrawablePadding=dp(20)
        background=StateListDrawable().apply{
          addState(intArrayOf(android.R.attr.state_pressed),android.graphics.drawable.ColorDrawable(if(dark)0xff45454a.toInt() else 0xffe4e4e8.toInt()))
          addState(intArrayOf(),android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        setOnClickListener{
          dialog.dismiss()
          // Selection handles need the conversation window to regain focus.
          if(action=="select")this@CodexerMessageTextView.text.postDelayed({
            val message=this@CodexerMessageTextView
            if(message.isAttachedToWindow && message.isShown)message.selectMessage()
          },250)
          else onAction(mapOf("action" to action))
        }
      },LinearLayout.LayoutParams(-1,dp(42)))
    }
    dialog.setContentView(root)
    dialog.window?.apply{
      setBackgroundDrawableResource(android.R.color.transparent)
      addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      attributes=attributes.apply{dimAmount=.18f}
      if(Build.VERSION.SDK_INT>=31){addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND);attributes=attributes.apply{setBlurBehindRadius(dp(20))}}
    }
    dialog.setOnDismissListener{menu=null;onSelection(mapOf("active" to false))}
    menu=dialog
    dialog.show()
    dialog.window?.setLayout(-1,-1)
    root.post{
      if(!dialog.isShowing)return@post
      val rootLocation=IntArray(2);root.getLocationOnScreen(rootLocation)
      rows.measure(MeasureSpec.makeMeasureSpec(panelWidth,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
      preview.measure(MeasureSpec.makeMeasureSpec(previewWidth,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
      val gap=dp(20)
      val totalHeight=rows.measuredHeight+gap+preview.measuredHeight
      val sourceTop=location[1]-rootLocation[1]-dp(11)
      val top=(sourceTop-rows.measuredHeight-gap).coerceIn(dp(16),max(dp(16),root.height-totalHeight-dp(16)))
      val right=(location[0]-rootLocation[0]+width+dp(15)).coerceIn(max(panelWidth,previewWidth)+dp(16),root.width-dp(16))
      root.addView(rows,android.widget.FrameLayout.LayoutParams(panelWidth,-2).apply{leftMargin=right-panelWidth;topMargin=top})
      root.addView(preview,android.widget.FrameLayout.LayoutParams(previewWidth,-2).apply{leftMargin=right-previewWidth;topMargin=top+rows.measuredHeight+gap})
    }
  }
}

/** Small stroke symbols keep the native menu aligned with the iOS reference. */
private class MessageMenuIcon(private val action:String,color:Int):Drawable(){
  private val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{this.color=color;style=Paint.Style.STROKE;strokeWidth=1.7f;strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND}
  override fun draw(canvas:Canvas){
    val checkpoint=canvas.save()
    canvas.translate(bounds.left.toFloat(),bounds.top.toFloat());canvas.scale(bounds.width()/24f,bounds.height()/24f)
    fun line(x:Float,y:Float,x2:Float,y2:Float)=canvas.drawLine(x,y,x2,y2,paint)
    fun path(vararg points:Float){val p=Path();p.moveTo(points[0],points[1]);for(i in 2 until points.size step 2)p.lineTo(points[i],points[i+1]);canvas.drawPath(p,paint)}
    when(action){
      "copy"->{canvas.drawRoundRect(3f,8f,15f,21f,2.5f,2.5f,paint);path(9f,7f,9f,5f,10f,3f,19f,3f,21f,5f,21f,14f,19f,16f,17f,16f)}
      "edit"->{val p=Path();p.moveTo(4f,16f);p.lineTo(16f,4f);p.quadTo(18f,2f,20f,4f);p.quadTo(22f,6f,20f,8f);p.lineTo(8f,20f);p.lineTo(3f,21f);p.close();canvas.drawPath(p,paint);line(14f,6f,18f,10f)}
      "select"->{path(5f,3f,3f,3f,3f,21f,5f,21f);path(19f,3f,21f,3f,21f,21f,19f,21f);line(9f,6f,15f,6f);line(9f,12f,15f,12f);line(9f,18f,15f,18f)}
      "share"->{path(4f,12f,4f,20f,20f,20f,20f,12f);line(12f,3f,12f,15f);path(8f,7f,12f,3f,16f,7f)}
    }
    canvas.restoreToCount(checkpoint)
  }
  override fun setAlpha(alpha:Int){paint.alpha=alpha}
  override fun setColorFilter(filter:android.graphics.ColorFilter?){paint.colorFilter=filter}
  @Suppress("DEPRECATION") override fun getOpacity()=android.graphics.PixelFormat.TRANSLUCENT
}
