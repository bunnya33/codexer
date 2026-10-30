param([int]$AgentProcessId)
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentMemory {
 [StructLayout(LayoutKind.Sequential)] struct MBI {public IntPtr BaseAddress,AllocationBase;public uint AllocationProtect;public UIntPtr RegionSize;public uint State,Protect,Type;}
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint flags,bool inherit,int id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr p,IntPtr a,out MBI info,UIntPtr size);
 [DllImport("psapi.dll",SetLastError=true)] static extern bool QueryWorkingSet(IntPtr p,IntPtr buffer,int size);
 [DllImport("psapi.dll",CharSet=CharSet.Unicode)] static extern uint GetMappedFileName(IntPtr p,IntPtr a,StringBuilder name,int length);
 public class Bucket { public string name;public long resident,shared,privateResident; }
 public static Bucket[] Sample(int id) {
  IntPtr p=OpenProcess(0x410,false,id);if(p==IntPtr.Zero) throw new Exception("OpenProcess failed");
  IntPtr buffer=IntPtr.Zero;try {
   int size=1024*1024;for(;;) {buffer=Marshal.AllocHGlobal(size);if(QueryWorkingSet(p,buffer,size))break;Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;size*=2;if(size>128*1024*1024)throw new Exception("QueryWorkingSet failed");}
   long count=Marshal.ReadIntPtr(buffer).ToInt64();var buckets=new Dictionary<string,Bucket>();
   var regionNames=new Dictionary<long,string>();MBI info=new MBI();long end=0,start=0;
   for(long n=0;n<count;n++) {
    ulong flags=unchecked((ulong)Marshal.ReadIntPtr(buffer,checked((int)(8*(n+1)))).ToInt64());long address=unchecked((long)(flags&~4095UL));
    if(address<start||address>=end) {if(VirtualQueryEx(p,new IntPtr(address),out info,new UIntPtr((uint)Marshal.SizeOf(typeof(MBI))))==UIntPtr.Zero)continue;start=info.BaseAddress.ToInt64();end=start+(long)info.RegionSize.ToUInt64();}
    string name;long allocation=info.AllocationBase.ToInt64();if(!regionNames.TryGetValue(allocation,out name)) {
     if(info.Type==0x1000000||info.Type==0x40000) {var path=new StringBuilder(2048);GetMappedFileName(p,new IntPtr(address),path,path.Capacity);name=(info.Type==0x1000000?"Image: ":"Mapped: ")+path.ToString();}
     else name="Private allocations";regionNames[allocation]=name;
    }
    Bucket b;if(!buckets.TryGetValue(name,out b)){b=new Bucket();b.name=name;buckets[name]=b;}b.resident+=4096;if((flags&256UL)!=0)b.shared+=4096;else b.privateResident+=4096;
   }
   var values=new List<Bucket>(buckets.Values);values.Sort((a,b)=>b.resident.CompareTo(a.resident));return values.ToArray();
  }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);CloseHandle(p);}
 }
}
'@
Add-Type -TypeDefinition $source
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$AgentProcessId"
[pscustomobject]@{processId=$AgentProcessId;workingSetBytes=[long]$process.WorkingSetSize;privateCommitBytes=[long]$process.PrivatePageCount;buckets=@([AgentMemory]::Sample($AgentProcessId))} | ConvertTo-Json -Depth 5 -Compress
